// Role: Tiny, safe markdown renderer for transcript prose.
// Boundary: Escapes by construction; does not render raw HTML.

const BLOCK_START = /^(#{1,6})\s+|^([-*+])\s+|^(\d+)\.\s+|^>\s?|^```/;

export function renderMarkdown(text = "", className = "") {
  const root = document.createElement("div");
  root.className = ["md", className].filter(Boolean).join(" ");

  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length;) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const pre = document.createElement("pre");
      const codeEl = document.createElement("code");
      if (lang) codeEl.dataset.lang = lang;
      codeEl.textContent = code.join("\n");
      pre.append(codeEl);
      root.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 1);
      const node = document.createElement(`h${level}`);
      appendInline(node, heading[2]);
      root.append(node);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const node = document.createElement("blockquote");
      node.append(renderMarkdown(quote.join("\n")));
      root.append(node);
      continue;
    }

    const unordered = line.match(/^([-*+])\s+(.*)$/);
    const ordered = line.match(/^(\d+)\.\s+(.*)$/);
    if (unordered || ordered) {
      const tag = ordered ? "ol" : "ul";
      const list = document.createElement(tag);
      while (i < lines.length) {
        const item = tag === "ol"
          ? lines[i].match(/^\d+\.\s+(.*)$/)
          : lines[i].match(/^[-*+]\s+(.*)$/);
        if (!item) break;
        const li = document.createElement("li");
        appendInline(li, item[1]);
        list.append(li);
        i++;
      }
      root.append(list);
      continue;
    }

    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) {
      paragraph.push(lines[i]);
      i++;
    }
    const node = document.createElement("p");
    appendInline(node, paragraph.join("\n"));
    root.append(node);
  }

  return root;
}

function appendInline(parent, text) {
  const pattern = /(`[^`]+`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g;
  let lastIndex = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > lastIndex) parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    parent.append(inlineNode(match));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parent.append(document.createTextNode(text.slice(lastIndex)));
}

function inlineNode(match) {
  if (match[0].startsWith("`")) {
    const node = document.createElement("code");
    node.textContent = match[0].slice(1, -1);
    return node;
  }
  if (match[2] && match[3]) {
    const node = document.createElement("a");
    node.href = match[3];
    node.target = "_blank";
    node.rel = "noreferrer";
    node.textContent = match[2];
    return node;
  }
  if (match[4] || match[5]) {
    const node = document.createElement("strong");
    node.textContent = match[4] ?? match[5];
    return node;
  }
  const node = document.createElement("em");
  node.textContent = match[6] ?? match[7] ?? match[0];
  return node;
}
