// The Lua checker — one implementation, used by the publish form AND the server.
//
// There used to be two checkers that disagreed. The form needed three of its
// own signals and the server needed two of different ones, so the most common
// Roblox script there is —
//
//     loadstring(game:HttpGet("https://…"))()
//
// — scored ONE on the form ("Doesn't look like Lua yet") while the server
// happily called it Lua. A publisher was told their script was wrong by the
// page and right by the site in the same minute.
//
// Now there is one function. _worker.js carries a byte-for-byte copy between
// the LUACHECK markers (it is a single file with no imports), and
// tests/luacheck.spec.mjs fails if the two ever drift apart.
//
// What it does, in order:
//   1. Lexes the source: strings, long strings, comments, Luau backtick
//      strings — so `--` inside a string or `end` inside a comment can't fool it.
//   2. Checks structure: every function/if/do/repeat is closed, brackets match,
//      strings and comments are terminated. These are real errors with line
//      numbers, and they block publishing.
//   3. Scores Lua/Roblox signals, and spots JavaScript, Python, HTML and prose
//      pasted by mistake.
//
// What it does NOT do: say the script is safe, working, or reviewed. Passing
// means "this is Lua-shaped text with balanced blocks". The badge it drives
// says "Lua Detected" and nothing more.

/* LUACHECK:BEGIN */
function checkLua(code) {
  const src = String(code == null ? "" : code).replace(/\r\n?/g, "\n");
  const trimmed = src.trim();
  const out = { ok: false, lua: false, score: 0, errors: [], why: "", lines: 0 };
  if (!trimmed) { out.why = "Paste the script's Lua code."; return out; }
  out.lines = src.split("\n").length;
  if (trimmed.length < 10) { out.why = "That's too short to be a script."; return out; }

  /* ---- 1. lex ---- */
  const toks = [];          // { v, line } — identifiers/keywords and punctuation
  const errors = [];
  let i = 0, line = 1, strings = 0, comments = 0;
  const n = src.length;
  const isId = (c) => /[A-Za-z0-9_]/.test(c);
  const longOpen = (at) => {           // "[", "=" * k, "[" → k, else -1
    if (src[at] !== "[") return -1;
    let k = 0, j = at + 1;
    while (src[j] === "=") { k++; j++; }
    return src[j] === "[" ? k : -1;
  };
  const skipLong = (at, k, what) => {  // returns index after the close, or n
    const close = "]" + "=".repeat(k) + "]";
    const startLine = line;
    const end = src.indexOf(close, at);
    const stop = end === -1 ? n : end + close.length;
    for (let j = at; j < stop; j++) if (src[j] === "\n") line++;
    if (end === -1) errors.push({ line: startLine, msg: `This ${what} is never closed (missing ${close}).` });
    return stop;
  };

  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\f" || c === "\v") { i++; continue; }

    // comments
    if (c === "-" && src[i + 1] === "-") {
      comments++;
      const k = longOpen(i + 2);
      if (k >= 0) { i = skipLong(i + 2 + k + 2, k, "long comment"); continue; }
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // long strings
    if (c === "[") {
      const k = longOpen(i);
      if (k >= 0) { strings++; i = skipLong(i + k + 2, k, "long string"); toks.push({ v: "\"", line }); continue; }
    }
    // quoted strings (and Luau backtick strings)
    if (c === "\"" || c === "'" || c === "`") {
      const startLine = line;
      let j = i + 1, closed = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") { if (src[j + 1] === "\n") line++; j += 2; continue; }
        if (d === c) { closed = true; j++; break; }
        if (d === "\n") {
          if (c === "`") { line++; j++; continue; }
          break;
        }
        j++;
      }
      if (!closed) errors.push({ line: startLine, msg: `A string opened with ${c} is never closed.` });
      strings++;
      toks.push({ v: "\"", line: startLine });
      i = j;
      continue;
    }
    // identifiers / keywords / numbers
    if (isId(c)) {
      let j = i;
      while (j < n && isId(src[j])) j++;
      toks.push({ v: src.slice(i, j), line });
      i = j;
      continue;
    }
    // multi-char operators that matter for context
    const two = src.slice(i, i + 2);
    if (["==", "~=", "<=", ">=", "..", "::", "->", "=>", "+=", "-=", "*=", "/="].includes(two)) {
      toks.push({ v: two, line }); i += 2; continue;
    }
    toks.push({ v: c, line });
    i++;
  }

  /* ---- 2. structure ---- */
  // `if` after one of these is a Luau if-EXPRESSION (`local x = if a then b
  // else c`), which has no `end`. Counting it as a block would report a
  // missing `end` on perfectly valid Luau.
  const EXPR_BEFORE = new Set(["=", "(", ",", "{", "[", "return", "and", "or", "not",
    "..", "+", "-", "*", "/", "%", "^", "==", "~=", "<", ">", "<=", ">=", "#", "+=", "-=", "*=", "/=", "then", "else"]);
  const OPENERS = { "(": ")", "{": "}", "[": "]" };
  const CLOSERS = { ")": "(", "}": "{", "]": "[" };
  const blocks = [];
  const brackets = [];
  for (let t = 0; t < toks.length; t++) {
    const { v, line: ln } = toks[t];
    const prev = t ? toks[t - 1].v : "";
    if (v === "function" || v === "do" || v === "repeat") blocks.push({ v, line: ln });
    else if (v === "if") {
      // "then"/"else" before `if` is only an expression when we are already
      // inside an if-expression; at statement level it starts a new block.
      const exprCtx = EXPR_BEFORE.has(prev) && prev !== "then" && prev !== "else";
      if (!exprCtx) blocks.push({ v, line: ln });
    } else if (v === "end") {
      const top = blocks.pop();
      if (!top) errors.push({ line: ln, msg: "There's an `end` here with no block for it to close." });
      else if (top.v === "repeat")
        errors.push({ line: ln, msg: `\`repeat\` from line ${top.line} must be closed with \`until\`, not \`end\`.` });
    } else if (v === "until") {
      const top = blocks.pop();
      if (!top || top.v !== "repeat")
        errors.push({ line: ln, msg: "There's an `until` here with no `repeat` before it." });
    } else if (OPENERS[v]) brackets.push({ v, line: ln });
    else if (CLOSERS[v]) {
      const top = brackets.pop();
      if (!top) errors.push({ line: ln, msg: `There's a \`${v}\` here with nothing to close.` });
      else if (top.v !== CLOSERS[v])
        errors.push({ line: ln, msg: `\`${v}\` here doesn't match the \`${top.v}\` opened on line ${top.line}.` });
    }
    if (errors.length > 6) break;
  }
  for (const b of blocks.slice(-3))
    errors.push({ line: b.line, msg: b.v === "repeat"
      ? `\`repeat\` on line ${b.line} is never closed with \`until\`.`
      : `\`${b.v}\` on line ${b.line} is never closed with \`end\`.` });
  for (const b of brackets.slice(-3))
    errors.push({ line: b.line, msg: `\`${b.v}\` on line ${b.line} is never closed.` });

  /* ---- 3. signals ---- */
  const words = new Set(toks.map((t) => t.v));
  const has = (re) => re.test(src);
  let score = 0;
  // Strong: things that are only ever Roblox Lua.
  if (has(/\bgame\s*:\s*GetService\s*\(/)) score += 2;
  if (has(/\bloadstring\s*\(/) && has(/:\s*HttpGet(Async)?\s*\(/)) score += 3;
  else if (has(/\bloadstring\s*\(/)) score += 2;
  if (has(/\blocal\s+function\b/)) score += 2;
  if (has(/:\s*(Connect|Once|Wait|FindFirstChild|WaitForChild|GetChildren|GetDescendants|Destroy|Clone|Fire|Invoke)\s*\(/)) score += 2;
  if (has(/\bInstance\s*\.\s*new\s*\(/)) score += 2;
  if (words.has("function") && words.has("end")) score += 2;
  // Ordinary Lua.
  if (has(/\blocal\s+[A-Za-z_]/)) score += 1;
  if (words.has("then") || words.has("elseif")) score += 1;
  if (words.has("nil") || words.has("~=")) score += 1;
  if (words.has("..")) score += 1;
  if (has(/\b(pairs|ipairs|tostring|tonumber|pcall|xpcall|typeof|setmetatable|require|print|warn|spawn|wait)\s*\(/)) score += 1;
  if (has(/\btask\s*\.\s*(wait|spawn|delay|defer)\b/)) score += 1;
  if (has(/\b(game|workspace|script|Enum|Vector3|CFrame|UDim2|Color3|Players|LocalPlayer|Humanoid|HumanoidRootPart|ReplicatedStorage|RunService|UserInputService|TweenService)\b/)) score += 1;
  if (has(/\b(getgenv|getrenv|hookfunction|hookmetamethod|getrawmetatable|setclipboard|fireclickdetector|firetouchinterest|syn|fluxus|Drawing)\b/)) score += 1;
  if (comments) score += 1;
  out.score = score;

  /* ---- 4. not Lua at all? ---- */
  let foreign = "";
  const js = [/\b(const|let|var)\s+[A-Za-z_$]/, /=>/, /\bconsole\s*\.\s*log\b/, /===|!==/, /\bfunction\s*[A-Za-z_$]*\s*\([^)]*\)\s*\{/, /;\s*$/m]
    .filter((re) => re.test(src)).length;
  const py = [/^\s*def\s+\w+\s*\(.*\)\s*:/m, /^\s*(import|from)\s+\w+/m, /\belif\b/, /^\s*(if|for|while)\b[^\n]*:\s*$/m, /\bself\./, /\bTrue\b|\bFalse\b|\bNone\b/]
    .filter((re) => re.test(src)).length;
  const html = /<\s*(html|head|body|div|span|script|style|p|a)\b[^>]*>/i.test(src);
  if (html && score < 4) foreign = "That looks like HTML, not Lua.";
  else if (js >= 2 && js > py && score < 5) foreign = "That looks like JavaScript, not Lua.";
  else if (py >= 2 && score < 5) foreign = "That looks like Python, not Lua.";

  const collapsed = trimmed.replace(/\s+/g, "");
  const mash = collapsed.length > 60 && new Set(collapsed).size <= 6;
  const prose = !foreign && score < 3 && /^[A-Za-z ,.'"!?\n-]{40,}$/.test(trimmed);

  out.errors = errors.slice(0, 4);
  out.lua = !foreign && !mash && score >= 3;

  if (foreign) out.why = foreign;
  else if (mash) out.why = "That looks like repeated characters rather than code.";
  else if (prose) out.why = "That looks like plain text rather than a Lua script.";
  else if (!out.lua && errors.length && score >= 2) out.why = `Line ${errors[0].line}: ${errors[0].msg}`;
  else if (!out.lua) out.why = "That doesn't look like Lua yet. Paste the script itself — for example local, function … end, game:GetService(…) or a loadstring(…) line.";
  else if (out.errors.length) out.why = `Line ${out.errors[0].line}: ${out.errors[0].msg}`;

  out.ok = out.lua && out.errors.length === 0;
  return out;
}
/* LUACHECK:END */

export { checkLua };
