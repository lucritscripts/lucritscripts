// Luau syntax highlighting. Single-pass tokeniser, HTML-escaped output.

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
  "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true",
  "until", "while", "continue", "export", "type",
]);

const GLOBALS = new Set([
  "game", "workspace", "script", "math", "table", "string", "task", "os",
  "Instance", "Vector3", "Vector2", "CFrame", "Color3", "UDim", "UDim2",
  "Enum", "Random", "Ray", "RaycastParams", "OverlapParams", "TweenInfo",
  "pcall", "xpcall", "print", "warn", "error", "assert", "typeof", "type",
  "tostring", "tonumber", "ipairs", "pairs", "next", "select", "unpack",
  "setmetatable", "getmetatable", "rawget", "rawset", "require", "coroutine",
  "tick", "wait", "spawn", "delay", "buffer", "bit32", "utf8",
]);

const TYPES = new Set([
  "string", "number", "boolean", "any", "nil", "void", "thread", "self",
  "Player", "Model", "BasePart", "Humanoid", "Instance", "Part", "Frame",
  "TextLabel", "TextButton", "ScreenGui", "Tool", "Sound", "Animation",
  "AnimationTrack", "Attachment", "RemoteEvent", "RemoteFunction", "DataStore",
  "OrderedDataStore", "RBXScriptConnection", "RBXScriptSignal", "Folder",
  "IntValue", "GuiObject", "SurfaceGui", "Animator", "AnimationController",
  "LinearVelocity", "BallSocketConstraint", "Motor6D", "InputObject",
]);

const esc = (s) => s
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const span = (cls, text) => `<span class="t-${cls}">${esc(text)}</span>`;

/**
 * Returns HTML for one line of Luau.
 * `state` carries multi-line block comment / string context between lines.
 */
function highlightLine(line, state) {
  let out = "";
  let i = 0;
  const n = line.length;

  while (i < n) {
    // inside a long comment or long string opened on a previous line
    if (state.long) {
      const close = "]" + "=".repeat(state.longLevel) + "]";
      const at = line.indexOf(close, i);
      const cls = state.longIsComment ? "comment" : "string";
      if (at === -1) {
        out += span(cls, line.slice(i));
        return out;
      }
      out += span(cls, line.slice(i, at + close.length));
      i = at + close.length;
      state.long = false;
      continue;
    }

    const ch = line[i];

    // long bracket comment / string  --[[ ]]  or  [[ ]]
    const longOpen = /^(--)?\[(=*)\[/.exec(line.slice(i));
    if (longOpen) {
      state.long = true;
      state.longLevel = longOpen[2].length;
      state.longIsComment = Boolean(longOpen[1]);
      const cls = state.longIsComment ? "comment" : "string";
      const close = "]" + "=".repeat(state.longLevel) + "]";
      const rest = line.slice(i + longOpen[0].length);
      const at = rest.indexOf(close);
      if (at === -1) {
        out += span(cls, line.slice(i));
        return out;
      }
      out += span(cls, line.slice(i, i + longOpen[0].length + at + close.length));
      i += longOpen[0].length + at + close.length;
      state.long = false;
      continue;
    }

    // line comment (and the --!strict directive)
    if (ch === "-" && line[i + 1] === "-") {
      const text = line.slice(i);
      out += span(text.startsWith("--!") ? "directive" : "comment", text);
      return out;
    }

    // strings
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === ch) { j++; break; }
        j++;
      }
      out += span("string", line.slice(i, j));
      i = j;
      continue;
    }

    // numbers
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] || ""))) {
      const m = /^(0[xX][0-9a-fA-F_]+|[0-9_]*\.?[0-9_]+([eE][+-]?[0-9]+)?)/.exec(line.slice(i));
      if (m) {
        out += span("number", m[0]);
        i += m[0].length;
        continue;
      }
    }

    // identifiers
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z0-9_]+/.exec(line.slice(i));
      const word = m[0];
      const after = line.slice(i + word.length);
      const before = line.slice(0, i);

      let cls;
      if (KEYWORDS.has(word)) cls = "keyword";
      else if (/^\s*[({"']/.test(after) && !/[:.]\s*$/.test(before)) cls = "fn";
      else if (/[:.]\s*$/.test(before) && /^\s*\(/.test(after)) cls = "method";
      else if (GLOBALS.has(word)) cls = "global";
      else if (TYPES.has(word)) cls = "type";
      else if (/^[A-Z]/.test(word)) cls = "type";
      else cls = null;

      out += cls ? span(cls, word) : esc(word);
      i += word.length;
      continue;
    }

    // operators and punctuation
    if (/[+\-*/%^#=~<>(){}[\];:,.|&]/.test(ch)) {
      const m = /^(\.\.\.|\.\.|==|~=|<=|>=|::|->|[+\-*/%^#=<>(){}[\];:,.|&])/.exec(line.slice(i));
      const op = m ? m[0] : ch;
      out += span(/[(){}[\];:,]/.test(op) && op.length === 1 ? "punct" : "op", op);
      i += op.length;
      continue;
    }

    out += esc(ch);
    i++;
  }

  return out;
}

/** Full document -> array of highlighted HTML lines. */
export function highlightLuau(code) {
  const state = { long: false, longLevel: 0, longIsComment: false };
  return code.replace(/\r\n/g, "\n").split("\n").map((l) => highlightLine(l, state));
}

/** Renders a complete code block with gutter line numbers. */
export function renderCodeBlock(code) {
  const lines = highlightLuau(code);
  const gutter = lines.map((_, i) => `<span>${i + 1}</span>`).join("");
  const body = lines.map((l) => `<span class="ln">${l || "&nbsp;"}</span>`).join("");
  return `<div class="code"><div class="code__gutter" aria-hidden="true">${gutter}</div><pre class="code__body"><code>${body}</code></pre></div>`;
}
