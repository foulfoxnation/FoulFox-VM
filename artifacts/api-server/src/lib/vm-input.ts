// Translate high-level computer-use actions (move/click/type/key/scroll/drag)
// into QMP `input-send-event` event batches.
//
// Each action becomes one or more *batches*; every batch is one input-send-event
// call (its events are applied atomically and in order by QEMU). Mouse position
// uses ABSOLUTE coordinates, which requires an absolute pointing device in the
// guest (the usb-tablet added in vm-launch.ts). QEMU maps the absolute axis
// range 0..0x7FFF across the full display, so we scale pixel coordinates from
// the screenshot the model is looking at.

export interface InputAction {
  type: string;
  x?: number;
  y?: number;
  x2?: number; // drag end-x
  y2?: number; // drag end-y
  button?: string; // left | middle | right
  keys?: string[]; // chord, e.g. ["ctrl","c"]
  key?: string; // single key, e.g. "Return"
  text?: string; // for type
  amount?: number; // scroll clicks (default 3)
  direction?: string; // scroll: up | down
}

const ABS_MAX = 0x7fff;

function absVal(px: number, span: number): number {
  if (!span || span <= 1) return 0;
  const clamped = Math.max(0, Math.min(px, span - 1));
  return Math.round((clamped / (span - 1)) * ABS_MAX);
}

function absEvents(x: number, y: number, w: number, h: number): unknown[] {
  return [
    { type: "abs", data: { axis: "x", value: absVal(x, w) } },
    { type: "abs", data: { axis: "y", value: absVal(y, h) } },
  ];
}

function btnEvent(button: string, down: boolean): unknown {
  return { type: "btn", data: { down, button } };
}

function keyEvent(qcode: string, down: boolean): unknown {
  return { type: "key", data: { down, key: { type: "qcode", data: qcode } } };
}

// Symbols typed with Shift held, mapped to the unshifted QKeyCode of that key.
const SHIFT_SYMBOLS: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7",
  "*": "8", "(": "9", ")": "0", _: "minus", "+": "equal",
  "{": "bracket_left", "}": "bracket_right", "|": "backslash",
  ":": "semicolon", '"': "apostrophe", "~": "grave_accent",
  "<": "comma", ">": "dot", "?": "slash",
};

// Punctuation typed without Shift, mapped to its QKeyCode.
const PUNCT: Record<string, string> = {
  "-": "minus", "=": "equal", "[": "bracket_left", "]": "bracket_right",
  "\\": "backslash", ";": "semicolon", "'": "apostrophe", "`": "grave_accent",
  ",": "comma", ".": "dot", "/": "slash", " ": "spc", "\t": "tab", "\n": "ret",
};

// Named keys → QKeyCode. Used by `key`/`keys` chords (modifiers + a key).
const NAMED_KEYS: Record<string, string> = {
  ctrl: "ctrl", control: "ctrl", ctrl_r: "ctrl_r",
  alt: "alt", option: "alt", alt_r: "alt_r", altgr: "alt_r",
  shift: "shift", shift_r: "shift_r",
  meta: "meta_l", cmd: "meta_l", command: "meta_l", win: "meta_l", super: "meta_l",
  enter: "ret", return: "ret", ret: "ret",
  tab: "tab", esc: "esc", escape: "esc", space: "spc", spc: "spc",
  backspace: "backspace", bksp: "backspace",
  delete: "delete", del: "delete", insert: "insert", ins: "insert",
  up: "up", down: "down", left: "left", right: "right",
  home: "home", end: "end",
  pageup: "pgup", pgup: "pgup", pagedown: "pgdn", pgdn: "pgdn",
  capslock: "caps_lock", caps_lock: "caps_lock",
  print: "print", sysrq: "sysrq", menu: "menu",
};

// Resolve a single character to a key press (its QKeyCode + whether Shift is held).
function charToKey(ch: string): { code: string; shift: boolean } | null {
  if (/^[a-z]$/.test(ch)) return { code: ch, shift: false };
  if (/^[A-Z]$/.test(ch)) return { code: ch.toLowerCase(), shift: true };
  if (/^[0-9]$/.test(ch)) return { code: ch, shift: false };
  if (ch in SHIFT_SYMBOLS) return { code: SHIFT_SYMBOLS[ch], shift: true };
  if (ch in PUNCT) return { code: PUNCT[ch], shift: false };
  return null; // unsupported character — skipped
}

// Resolve a key name (for chords) to a QKeyCode.
function keyNameToQcode(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  if (n in NAMED_KEYS) return NAMED_KEYS[n];
  if (/^[a-z0-9]$/.test(n)) return n;
  if (/^f([1-9]|1[0-2])$/.test(n)) return n; // f1..f12
  if (n in PUNCT) return PUNCT[n];
  if (n in SHIFT_SYMBOLS) return SHIFT_SYMBOLS[n]; // best-effort (no auto-shift)
  return null;
}

function typeCharBatch(ch: string): unknown[] | null {
  const k = charToKey(ch);
  if (!k) return null;
  const batch: unknown[] = [];
  if (k.shift) batch.push(keyEvent("shift", true));
  batch.push(keyEvent(k.code, true));
  batch.push(keyEvent(k.code, false));
  if (k.shift) batch.push(keyEvent("shift", false));
  return batch;
}

function normButton(b?: string): string {
  const v = (b || "left").toLowerCase();
  if (v === "left" || v === "middle" || v === "right") return v;
  return "left";
}

// Build the QMP event batches for one action. Throws on an unknown/invalid
// action so the route can return a clear 400.
export function actionToEventBatches(
  a: InputAction,
  screenW: number,
  screenH: number,
): unknown[][] {
  const t = (a.type || "").toLowerCase();
  const hasXY = typeof a.x === "number" && typeof a.y === "number";

  switch (t) {
    case "move": {
      if (!hasXY) throw new Error("move requires x and y");
      return [absEvents(a.x!, a.y!, screenW, screenH)];
    }
    case "click":
    case "left_click":
    case "right_click":
    case "middle_click": {
      const button = t === "right_click" ? "right" : t === "middle_click" ? "middle" : normButton(a.button);
      const press: unknown[] = [];
      if (hasXY) press.push(...absEvents(a.x!, a.y!, screenW, screenH));
      press.push(btnEvent(button, true));
      return [press, [btnEvent(button, false)]];
    }
    case "double_click":
    case "doubleclick": {
      const button = normButton(a.button);
      const press: unknown[] = [];
      if (hasXY) press.push(...absEvents(a.x!, a.y!, screenW, screenH));
      press.push(btnEvent(button, true));
      return [
        press,
        [btnEvent(button, false)],
        [btnEvent(button, true)],
        [btnEvent(button, false)],
      ];
    }
    case "mouse_down": {
      const button = normButton(a.button);
      const press: unknown[] = [];
      if (hasXY) press.push(...absEvents(a.x!, a.y!, screenW, screenH));
      press.push(btnEvent(button, true));
      return [press];
    }
    case "mouse_up": {
      const button = normButton(a.button);
      const rel: unknown[] = [];
      if (hasXY) rel.push(...absEvents(a.x!, a.y!, screenW, screenH));
      rel.push(btnEvent(button, false));
      return [rel];
    }
    case "drag": {
      if (!hasXY || typeof a.x2 !== "number" || typeof a.y2 !== "number") {
        throw new Error("drag requires x, y, x2, y2");
      }
      const button = normButton(a.button);
      return [
        [...absEvents(a.x!, a.y!, screenW, screenH), btnEvent(button, true)],
        absEvents(a.x2, a.y2, screenW, screenH),
        [btnEvent(button, false)],
      ];
    }
    case "scroll": {
      const dir = (a.direction || "down").toLowerCase();
      const wheel = dir === "up" ? "wheel-up" : "wheel-down";
      const clicks = Math.max(1, Math.min(Math.floor(a.amount ?? 3), 30));
      const batches: unknown[][] = [];
      if (hasXY) batches.push(absEvents(a.x!, a.y!, screenW, screenH));
      for (let i = 0; i < clicks; i++) {
        batches.push([btnEvent(wheel, true)]);
        batches.push([btnEvent(wheel, false)]);
      }
      return batches;
    }
    case "key":
    case "hotkey":
    case "keypress": {
      const names = a.keys && a.keys.length ? a.keys : a.key ? [a.key] : [];
      if (!names.length) throw new Error("key requires `keys` or `key`");
      const codes: string[] = [];
      for (const n of names) {
        const c = keyNameToQcode(n);
        if (!c) throw new Error(`unknown key: ${n}`);
        codes.push(c);
      }
      // Press all in order, release in reverse (modifiers wrap the final key).
      const batch: unknown[] = [];
      for (const c of codes) batch.push(keyEvent(c, true));
      for (let i = codes.length - 1; i >= 0; i--) batch.push(keyEvent(codes[i], false));
      return [batch];
    }
    case "type":
    case "type_text": {
      const text = a.text ?? "";
      if (!text) throw new Error("type requires `text`");
      const batches: unknown[][] = [];
      for (const ch of text) {
        const b = typeCharBatch(ch);
        if (b) batches.push(b);
      }
      if (!batches.length) throw new Error("type: no typable characters in text");
      return batches;
    }
    default:
      throw new Error(`unknown action type: ${a.type}`);
  }
}

// Does this action reference screen coordinates (so the route must know the
// display size to scale them)?
export function actionNeedsCoords(a: InputAction): boolean {
  const t = (a.type || "").toLowerCase();
  if (["move", "drag"].includes(t)) return true;
  const coordTypes = ["click", "left_click", "right_click", "middle_click", "double_click", "doubleclick", "mouse_down", "mouse_up", "scroll"];
  return coordTypes.includes(t) && typeof a.x === "number" && typeof a.y === "number";
}
