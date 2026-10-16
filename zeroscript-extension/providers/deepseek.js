// SPDX-License-Identifier: GPL-3.0-or-later
// providers/deepseek.js - the DeepSeek (chat.deepseek.com) provider.
// EVERYTHING that knows DeepSeek's DOM, quirks, and UI strings lives here; the
// core (core/main.js) only ever talks to the ZSProvider interface this file
// exports. To support another AI site, write a sibling file exporting the same
// interface and list it (instead of this one) in the manifest's content_scripts.
//
// DeepSeek notes (validated live):
//  - One turn = one .ds-message. User turns carry a hashed modifier class +
//    a `.fbb737a4` bubble; assistant turns carry a `.ds-markdown` body.
//  - DeepThink/R1 reasoning lives in .ds-think-content; the real answer is a
//    .ds-markdown OUTSIDE that container (so drafts inside reasoning are ignored).
//  - The input is a real <textarea> (not a contenteditable): we set its value via
//    the native prototype setter + an input event, then click the primary send button.
//  - "generating" is detected from the primary footer button: while streaming it
//    shows a STOP glyph (a <rect> in old builds, a rounded-square <path> starting
//    "M2…" in V4) and when idle a SEND arrow (<path> starting "M8…"); see
//    isStopBtn(). .ds-loading covers the brief spin-up. During the DeepThink
//    REASONING phase there is NO stop button / spinner at all - only text growth
//    says "still alive".
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  // DOM selectors for chat.deepseek.com. Grouped so a future site tweak is a
  // one-liner. DeepSeek ships hashed CSS-module class names (e.g. `d29f3d7d`);
  // where possible we lean on its stable design-system "ds-" classes instead.
  const S = {
    chatItem: ".ds-message",
    userMod: "d29f3d7d", // hashed modifier on user turns (one-liner to update if DeepSeek redeploys)
    userBubble: ".fbb737a4", // user text bubble (secondary signal)
    box: ".ds-markdown",
    editor: "textarea", // DeepSeek uses a real <textarea>, NOT a contenteditable
    // The inline "edit this message" box is DeepSeek's design-system bordered
    // textarea (.ds-textarea--bordered), mounted UP in the turn list. The bottom
    // composer is NOT wrapped in one - so this scopes getEditor() away from it.
    msgEditBox: ".ds-textarea",
    thinking: ".ds-think-content",
    markdown: ".ds-markdown",
    generating: ".ds-loading",
    sendBtn: ".ds-button--primary",
    stopBtn: ".ds-button--primary",
    // surfaces where DeepSeek shows errors / limit modals / toasts
    errorSurfaces:
      '[class*="ds-toast"],[class*="toast"],[class*="error"],[class*="alert"],' +
      '[class*="warning"],[class*="modal"],[role="alert"]',
    // composer image-attachment area (best-effort; DeepSeek's image support is
    // limited, so the attach path degrades gracefully if these don't match).
    attachArea: ".ds-file-list, [class*='file-preview'], [class*='upload']",
    imageThumb: "[class*='thumbnail'], [class*='file-item']",
    // ── Composer mode controls (empty chat only) ──────────────────────────
    modeRadioGroup: '[role="radiogroup"]',
    modeRadio: '[role="radio"]',
    deepThinkToggle: ".ds-toggle-button",
  };

  // Error / state regexes (English + French - DeepSeek's UI follows the locale).
  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "session.{0,20}(expired|expir\\u00e9e)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "message.{0,20}too.{0,10}long",
        "maximum.{0,20}context",
        "this conversation has reached",
        "cette conversation a atteint",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /server is busy|serveur est occup|please try again|réessayer plus tard|system is currently busy/i,
    continueBtn: /^(continue|continuer|继续(生成)?|fortfahren|continuar|seguir|続行)$/i,
    stopped: /(arrêté|arrété|stopped|已停止|停止生成|已暂停)/i,
    expertMode: /expert|专家|专业/i,
    instantMode: /instant|rapide|快速/i,
    visionMode: /vision|视觉|图像|多模态/i,
    deepThink: /pensée profonde|pensee profonde|profonde|réflexion|reflexion|deep ?think|深度思考|r1/i,
    searchMode: /recherche intelligente|smart search|search|web|搜索/i,
  };

  const timings = {
    GEN_IDLE_MS: 800,         
    REASON_IDLE_MS: 12000,    
    WARMUP_MS: 45000,         
    REASON_NOREPLY_MS: 90000, 
    STABLE_MS: 9000,          
    RESPONSE_TIMEOUT_MS: 300000,
  };

  function isUserItem(item) {
    if (!item) return false;
    if (S.userMod && item.classList.contains(S.userMod)) return true;
    if (S.userBubble && item.querySelector(S.userBubble)) return true;
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  function itemText(item) {
    if (isAssistantItem(item)) {
      const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
      return mds.map((m) => m.textContent).join("\n");
    }
    return item.textContent || "";
  }

  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      return [...item.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !(excludeSel && m.closest(excludeSel)))
        .map((m) => m.textContent).join("\n");
    }
    let t = "";
    for (const n of item.childNodes) {
      if (excludeSel && n.nodeType === 1 && n.matches && n.matches(excludeSel)) continue;
      t += n.textContent || "";
    }
    return t;
  }

  const allItems = () => [...document.querySelectorAll(S.chatItem)];
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  
  const getEditor = () => {
    const site = [...document.querySelectorAll(S.editor)].filter(
      (e) => !e.closest("#bridge-root") && !e.closest("#zs-root")
    );
    return site.find((e) => !e.closest(S.msgEditBox)) || site[0] || null;
  };
  
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return (e.value != null ? e.value : e.textContent || "");
  };

  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      if (!ed.dataset.zsPlaceholder) ed.dataset.zsPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("readonly", "");
      ed.setAttribute("placeholder", "⏳ Agent working… please wait");
    } else {
      ed.removeAttribute("readonly");
      if (ed.dataset.zsPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.zsPlaceholder);
    }
  }

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  function lastAssistantId() {
    const last = lastAssistant();
    return itemKey(last);
  }

  function itemKey(item) {
    if (!item) return null;
    const p = item.parentElement;
    const key = p && p.getAttribute("data-virtual-list-item-key");
    return key != null ? key : null;
  }

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor() && !/\/s\/[^/]+/.test(location.pathname);

  function composerFrame() {
    const ta = getEditor();
    if (!ta) return null;
    const sb = document.querySelector(S.sendBtn);
    const group = document.querySelector(S.modeRadioGroup);
    let f = ta;
    for (let i = 0; i < 6 && f.parentElement; i++) f = f.parentElement;
    return f;
  }

  function barMount() {
    const ta = getEditor();
    if (!ta) return null;
    const send = document.querySelector(S.sendBtn);
    const group = document.querySelector(S.modeRadioGroup);
    let box = ta.parentElement;
    while (box && box !== document.body) {
      const holdsSend = !send || box.contains(send);
      const holdsTabs = group && box.contains(group);
      if (holdsSend && !holdsTabs) break;
      box = box.parentElement;
    }
    if (!box || box === document.body) box = ta.parentElement;
    if (!box) return null;
    let before = box.firstElementChild;
    if (before && (before.id === "bridge-bar" || before.id === "zs-bar")) before = before.nextElementSibling;
    return { parent: box, before, inside: true };
  }

  const nodeText = (n) => (n && (n.innerText || n.textContent || "").trim()) || "";
  const isPressedOn = (n) =>
    n && (n.getAttribute("aria-pressed") === "true" ||
         n.getAttribute("aria-checked") === "true" ||
         n.classList.contains("ds-toggle-button--selected"));
  const isPressedOff = (n) =>
    n && (n.getAttribute("aria-pressed") === "false" ||
         n.getAttribute("aria-checked") === "false");

  function findModeRadio(type, re) {
    const group = document.querySelector(S.modeRadioGroup);
    const radios = group ? [...group.querySelectorAll(S.modeRadio)] : [...document.querySelectorAll(S.modeRadio)];
    return radios.find((r) => r.getAttribute("data-model-type") === type) ||
           (re && radios.find((r) => re.test(nodeText(r)))) ||
           null;
  }
  const findExpertRadio = () => findModeRadio("expert", RE.expertMode);
  const findVisionRadio = () => findModeRadio("vision", RE.visionMode);
  const findInstantRadio = () => findModeRadio("default", RE.instantMode);
  const radioOn = (r) => !!r && r.getAttribute("aria-checked") === "true";

  let _visLatch = false, _visLatchSet = false, _visAt = 0, _visCache = false;
  function badgeVision() {
    const els = [...document.querySelectorAll("div,span")].filter(
      (e) => e.childElementCount === 0 &&
             /^(instant|expert|vision)$/i.test((e.textContent || "").trim()) &&
             e.getBoundingClientRect().width > 0);
    if (!els.length) return null;
    els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return /vision/i.test(els[0].textContent || "");
  }
  function detectVision() {
    const now = Date.now();
    if (now - _visAt < 400) return _visCache;
    _visAt = now;
    const group = document.querySelector(S.modeRadioGroup);
    if (group) {
      const v = findVisionRadio();
      if (v) { _visLatch = radioOn(v); _visLatchSet = true; return (_visCache = _visLatch); }
    }
    const b = badgeVision();
    if (b != null) { _visLatch = b; _visLatchSet = true; return (_visCache = b); }
    if (_visLatchSet) return (_visCache = _visLatch);
    return (_visCache = true);
  }
  const isVisionSelected = () => detectVision();

  function findToggleBy(re) {
    return [...document.querySelectorAll(S.deepThinkToggle)].find((t) => re.test(nodeText(t))) || null;
  }

  function composerModeState() {
    const expert = findExpertRadio();
    const deepThink = findToggleBy(RE.deepThink);
    const search = findToggleBy(RE.searchMode);
    const vision = findVisionRadio();
    const instant = findInstantRadio();
    return {
      expertFound: !!expert,
      expertOn: radioOn(expert),
      visionFound: !!vision,
      visionOn: radioOn(vision),
      instantFound: !!instant,
      instantOn: radioOn(instant),
      deepThinkFound: !!deepThink,
      deepThinkOn: !!deepThink && isPressedOn(deepThink),
      searchFound: !!search,
      searchOff: !search || !isPressedOn(search),
      searchHiddenInExpert: !search && !!expert && expert.getAttribute("aria-checked") === "true",
    };
  }

  function enforceComposer(reason) {
    if (!reason) return composerModeState();
    try {
      if (!isVisionSelected() && !radioOn(findInstantRadio())) {
        const expert = findExpertRadio();
        if (expert && expert.getAttribute("aria-checked") !== "true") {
          try { expert.click(); } catch (e) { diag("mode_fallback", { reason, target: "expert", error: String(e && e.message || e) }); }
        }
      }
      const deepThink = findToggleBy(RE.deepThink);
      if (deepThink && isPressedOff(deepThink)) {
        try { deepThink.click(); } catch (e) { diag("mode_fallback", { reason, target: "deepThink", error: String(e && e.message || e) }); }
      }
      const search = findToggleBy(RE.searchMode);
      if (search && isPressedOn(search)) {
        try { search.click(); } catch (e) { diag("mode_fallback", { reason, target: "search", error: String(e && e.message || e) }); }
      }
      const state = composerModeState();
      diag("mode_enforce", { reason, ...state });
      return state;
    } catch (e) {
      diag("mode_fallback", { reason, target: "composer", error: String(e && e.message || e) });
      return composerModeState();
    }
  }

  async function ensureComposerReady(reason) {
    let state = composerModeState();
    for (let i = 0; i < 12; i++) {
      state = enforceComposer(reason);
      const anyModel = state.expertOn || state.visionOn || state.instantOn ||
        (!state.expertFound && !state.visionFound && !state.instantFound);
      if (anyModel && state.searchOff && (state.deepThinkOn || !state.deepThinkFound)) break;
      await sleep(120);
    }
    state = composerModeState();
    const unified = !state.expertFound && !state.visionFound && !state.instantFound;
    diag("mode_ready", { reason, unified, ...state });
    return { ...state, unified, ready: state.expertOn || state.visionOn || state.instantOn || (unified && state.searchOff) };
  }

  function isStopBtn(btn) {
    if (!btn) return false;
    if (btn.querySelector("rect")) return true;
    const p = btn.querySelector("path");
    if (!p) return false;
    return /^\s*M\s*[0-3][\s.]/.test(p.getAttribute("d") || "");
  }

  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? think.textContent || "" : "";
    const replyTxt = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".bridge-chip") && !m.closest(".zs-chip"))
      .map((m) => m.textContent)
      .join("");
    return thinkTxt + "\n" + replyTxt;
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;

  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  function reasoningInProgress(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    if (!thinkTxt.trim().length) return false;
    const replyLen = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".bridge-chip") && !m.closest(".zs-chip"))
      .reduce((n, m) => n + (m.textContent || "").length, 0);
    if (replyLen !== 0) return false;
    if (turnHalted(item)) return false;
    return true;
  }

  function turnHalted(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    return RE.stopped.test(item.textContent || "") && !RE.stopped.test(thinkTxt);
  }

  function isGenerating() {
    if (document.querySelector(S.generating)) return true;
    const btn = document.querySelector(S.sendBtn);
    if (isStopBtn(btn)) return true;
    sampleStream();
    if (reasoningInProgress(lastAssistant())) return grewWithin(timings.REASON_IDLE_MS);
    return grewWithin(timings.GEN_IDLE_MS);
  }

  function isBusyNow() {
    if (document.querySelector(S.generating)) return true;
    const btn = document.querySelector(S.sendBtn);
    if (isStopBtn(btn)) return true;
    sampleStream();
    if (!reasoningInProgress(lastAssistant())) return false;
    return grewWithin(timings.REASON_IDLE_MS);
  }

  function isHardGenerating() {
    return isStopBtn(document.querySelector(S.sendBtn));
  }

  function genDebug() {
    try {
      sampleStream();
      const btn = document.querySelector(S.sendBtn);
      const path = btn && btn.querySelector("path");
      const rp = btn && btn.querySelector("rect");
      return {
        spinner: !!document.querySelector(S.generating),
        stopBtn: isStopBtn(btn),
        btnGlyph: rp ? "rect" : (path ? (path.getAttribute("d") || "").slice(0, 6) : "none"),
        reasoning: reasoningInProgress(lastAssistant()),
        streamMax: _streamMax,
        streamAgeMs: _streamAt ? Date.now() - _streamAt : -1,
        grewGen: grewWithin(timings.GEN_IDLE_MS),
        grewReason: grewWithin(timings.REASON_IDLE_MS),
        gen: isGenerating(),
      };
    } catch (e) { return { err: String(e && e.message || e) }; }
  }

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const th = it.querySelector(S.thinking);
      const rp = [...it.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !m.closest(".bridge-chip") && !m.closest(".zs-chip"))
        .reduce((n, m) => n + (m.textContent || "").length, 0);
      return { th: th ? (th.textContent || "").trim().length : 0, rp };
    } catch { return {}; }
  }

  function findContinueBtn() {
    for (const b of document.querySelectorAll(".ds-button")) {
      if (b.offsetParent === null) continue;
      if (RE.continueBtn.test((b.innerText || "").trim())) return b;
    }
    return null;
  }

  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const th = item.querySelector(`${S.thinking} ${S.markdown}`);
    const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    return {
      present: true,
      reply: mds.map((m) => m.textContent).join("\n").trim(),
      thinking: th ? th.textContent.trim() : "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Humanized chunk typing to bypass automated keystroke detection
  async function typePromptHumanized(editor, text) {
    editor.focus();
    setTextareaValue(editor, "");
    
    const chunks = text.match(/[\s\S]{1,12}/g) || [text];
    
    for (const chunk of chunks) {
      const currentVal = editor.value || "";
      setTextareaValue(editor, currentVal + chunk);
      
      const jitter = Math.floor(Math.random() * 70) + 25;
      await sleep(jitter);
    }
    
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function sendPrompt(text) {
    const editor = getEditor();
    if (!editor) return { ok: false, error: "editor not found" };

    if (isBusyNow()) {
      return { ok: false, error: "model is busy generating" };
    }

    await typePromptHumanized(editor, text);
    await sleep(Math.floor(Math.random() * 300) + 200);

    const sendBtn = document.querySelector(S.sendBtn);
    if (!sendBtn || isStopBtn(sendBtn)) {
      return { ok: false, error: "send button unavailable or blocked" };
    }

    try {
      sendBtn.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  const supportsVision = {
    get current() {
      return isVisionSelected();
    }
  };

  function init(diagnosticCallback) {
    diag = diagnosticCallback;
  }

  return {
    init,
    getEditor,
    editorText,
    setInputLock,
    allItems,
    assistantItems,
    assistantCount,
    userCount,
    lastAssistant,
    lastAssistantId,
    itemKey,
    isUserItem,
    isAssistantItem,
    itemText,
    classifyText,
    chatIsEmpty,
    isFreshChat,
    composerFrame,
    barMount,
    ensureComposerReady,
    isGenerating,
    isBusyNow,
    isHardGenerating,
    genDebug,
    snapshot,
    findContinueBtn,
    clickContinueBtn,
    readAssistant,
    waitFor,
    sendPrompt,
    supportsVision,
    streamLen,
    streamText,
    turnHalted,
  };
})();
