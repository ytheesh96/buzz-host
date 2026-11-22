// Instructions, rendered as Buzz renders them (react-markdown + remark-gfm parity).
// Buzz shows an Interest's instructions with react-markdown (its
// InstructionsMarkdown): GFM, raw HTML shown as text, its link policy, compact
// headings and its Markdown stylesheet. The same parser is bundled in
// generated/markdown-parser.js (markdownParser()); this turns its tree into the
// elements react-markdown makes from it (mdast-util-to-hast), under Buzz's classes.
import { markdownParser } from "./generated/markdown-parser.js";

export const MD_CLASS = "attention-markdown text-body-sm text-secondary";
export const MD_CHARS = 100_000; // MAX_MARKDOWN_LENGTH
export const MD_DEPTH = 100; // MAX_MARKDOWN_DEPTH
export const MD_CELLS = 10_000; // DOCUMENT_RENDER_CELLS
export const mdUrl = (url) => (/^(https?:|mailto:|buzz:|nostr:|#)/i.test(url ?? "") ? url : "");

/** Parsed as remark-parse with remark-gfm does, or undefined past Buzz's limits. */
export function parseInstructions(text) {
  if (text.length > MD_CHARS) return undefined;
  let tree;
  try {
    const { fromMarkdown, gfm, gfmFromMarkdown } = markdownParser();
    tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  } catch {
    return undefined;
  }
  let cells = 0;
  const pending = [{ node: tree, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (depth > MD_DEPTH) return undefined;
    if (node.type === "table") cells += (node.children[0]?.children.length ?? 0) * node.children.length;
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
  }
  return cells > MD_CELLS ? undefined : tree;
}

/** Buzz's observeTableOverflow: marks a table wider than its column. */
const observeTable = (table) => {
  if (!table || typeof ResizeObserver === "undefined") return undefined;
  const update = () => {
    const overflow = String(table.scrollWidth > table.clientWidth);
    if (table.dataset.overflow !== overflow) table.dataset.overflow = overflow;
  };
  update();
  const resize = new ResizeObserver(update);
  resize.observe(table);
  const content = new MutationObserver(update);
  content.observe(table, { childList: true, characterData: true, subtree: true });
  return () => {
    resize.disconnect();
    content.disconnect();
  };
};

const looseItem = (item) => (item.spread ?? null) === null ? item.children.length > 1 : item.spread;
const looseList = (list) => Boolean(list.spread) || list.children.some(looseItem);

export function createMarkdown({ React, doc } = {}) {
  const h = React.createElement;
  const getDoc = () => doc ?? document;

  /** Buzz's Markdown stylesheet is a CSS module, so its class names carry a
   * build hash (`_document_m4s2h_1`): read them from the loaded stylesheet.
   * Without them the instructions keep the Attention tab's own styles. */
  let mdClasses;
  let mdLookedAt = 0;
  function markdownClasses() {
    if (mdClasses || Date.now() - mdLookedAt < 5000) return mdClasses ?? {};
    mdLookedAt = Date.now();
    const modules = new Map();
    const scan = (rules) => {
      for (const rule of rules) {
        for (const [name, local, hash] of rule.selectorText?.matchAll(/\._(document|compact|imageAlt|source)_([a-z0-9]+)_\d+/g) ?? []) {
          const found = modules.get(hash) ?? {};
          found[local] ??= name.slice(1);
          modules.set(hash, found);
        }
        if (rule.cssRules) scan(rule.cssRules);
      }
    };
    for (const sheet of getDoc().styleSheets) {
      try {
        scan(sheet.cssRules);
      } catch {}
    }
    mdClasses = [...modules.values()].find((c) => c.document && c.compact && c.imageAlt);
    return mdClasses ?? {};
  }

  /** InstructionsMarkdown's link. A person (`nostr:npub…`) shows as their name:
   * Buzz opens profiles only from tabs its host gives an opener, and an agent
   * type's tabs get none. */
  const mdLink = (href, children, key) =>
    !href || /^nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(href)
      ? h("span", { key }, ...children)
      : h("a", { key, href, target: "_blank", rel: "noreferrer" }, ...children);

  /** mdast → React, as mdast-util-to-hast and react-markdown build it. */
  function renderMarkdown(tree, classes) {
    const definitions = new Map();
    const footnotes = new Map();
    const order = [];
    const uses = new Map();
    const normalize = (id) => String(id).replace(/[\t\n\r ]+/g, " ").trim().toLowerCase().toUpperCase();
    (function collect(node) {
      if (node.type === "definition" && !definitions.has(normalize(node.identifier))) definitions.set(normalize(node.identifier), node);
      if (node.type === "footnoteDefinition" && !footnotes.has(normalize(node.identifier))) footnotes.set(normalize(node.identifier), node);
      for (const child of node.children ?? []) collect(child);
    })(tree);
    const all = (node, loose) => (node.children ?? []).map((child, i) => one(child, i, node, loose));
    /** to-hast's wrap: line endings between blocks (and around them, if loose). */
    const wrap = (nodes, loose) => {
      const out = [];
      nodes.filter((n) => n !== null).forEach((n, i) => out.push(...(i || loose ? ["\n"] : []), n));
      if (loose && out.length) out.push("\n");
      return out;
    };
    const text = (value) => String(value).replace(/[ \t]*(\r?\n|\r)[ \t]*/g, "$1");
    const revert = (node, key) => {
      const suffix = node.referenceType === "full" ? `[${node.label || node.identifier}]` : node.referenceType === "collapsed" ? "[]" : "";
      if (node.type === "imageReference") return `![${node.alt ?? ""}]${suffix}`;
      return h(React.Fragment, { key }, "[", ...all(node), `]${suffix}`);
    };
    function item(node, key, list) {
      const loose = list ? looseList(list) : looseItem(node);
      const results = all(node, loose);
      const kids = [];
      node.children.forEach((child, i) => {
        if (loose || i !== 0 || child.type !== "paragraph") kids.push("\n");
        if (child.type === "paragraph" && !loose) kids.push(...[results[i]].flat());
        else kids.push(results[i]);
      });
      if (typeof node.checked === "boolean") {
        const box = h("input", { key: "check", type: "checkbox", checked: node.checked, disabled: true });
        const first = node.children[0];
        if (first?.type === "paragraph") {
          const at = loose ? 1 : kids.findIndex((k) => k !== "\n");
          const p = kids[at];
          const inner = loose && p ? [p.props.children ?? []].flat() : [];
          if (loose && p) kids[at] = h("p", { key: p.key }, box, inner.length ? " " : null, ...inner);
          else kids.splice(Math.max(at, 0), 0, box, " ");
        } else kids.unshift(box);
      }
      if (node.children.length && (loose || node.children.at(-1).type !== "paragraph")) kids.push("\n");
      return h("li", { key, className: typeof node.checked === "boolean" ? "task-list-item" : undefined }, ...kids);
    }
    function one(node, key, parent, loose) {
      switch (node.type) {
        case "paragraph":
          // A tight list item holds its paragraphs' contents (see item).
          return parent?.type === "listItem" && loose === false ? all(node) : h("p", { key }, ...all(node));
        case "heading":
          return h(`h${node.depth}`, { key }, ...all(node));
        case "thematicBreak":
          return h("hr", { key });
        case "blockquote":
          return h("blockquote", { key }, ...wrap(all(node), true));
        case "list":
          return h(
            node.ordered ? "ol" : "ul",
            {
              key,
              start: node.ordered && typeof node.start === "number" && node.start !== 1 ? node.start : undefined,
              className: node.children.some((c) => typeof c.checked === "boolean") ? "contains-task-list" : undefined,
            },
            ...node.children.map((child, i) => item(child, i, node)),
          );
        case "listItem":
          return item(node, key);
        case "code": {
          const lang = node.lang?.split(/\s+/)[0];
          return h("pre", { key }, h("code", { className: lang ? `language-${lang}` : undefined }, node.value ? `${node.value}\n` : ""));
        }
        case "table": {
          const [head, ...rows] = node.children;
          const row = (r, i, cell) =>
            h(
              "tr",
              { key: i },
              ...(node.align ?? r.children).map((_, c) =>
                h(cell, { key: c, style: node.align?.[c] ? { textAlign: node.align[c] } : undefined }, ...(r.children[c] ? all(r.children[c]) : [])),
              ),
            );
          return h(
            "table",
            { key, ref: observeTable },
            head && h("thead", null, row(head, 0, "th")),
            rows.length > 0 && h("tbody", null, ...rows.map((r, i) => row(r, i, "td"))),
          );
        }
        case "html":
          return text(node.value); // literal, as Buzz shows raw HTML
        case "text":
          return text(node.value);
        case "break":
          return [h("br", { key }), "\n"];
        case "emphasis":
          return h("em", { key }, ...all(node));
        case "strong":
          return h("strong", { key }, ...all(node));
        case "delete":
          return h("del", { key }, ...all(node));
        case "inlineCode":
          return h("code", { key }, node.value.replace(/\r?\n|\r/g, " "));
        case "link":
          return mdLink(mdUrl(node.url), all(node), key);
        case "linkReference": {
          const def = definitions.get(normalize(node.identifier));
          return def ? mdLink(mdUrl(def.url), all(node), key) : revert(node, key);
        }
        case "image":
        case "imageReference":
          if (node.type === "imageReference" && !definitions.has(normalize(node.identifier))) return revert(node, key);
          return node.alt ? h("span", { key, className: classes.imageAlt }, node.alt) : null;
        case "footnoteReference": {
          const id = normalize(node.identifier);
          if (!order.includes(id)) order.push(id);
          uses.set(id, (uses.get(id) ?? 0) + 1);
          const slug = encodeURIComponent(id.toLowerCase());
          return h("sup", { key }, mdLink(`#user-content-fn-${slug}`, [String(order.indexOf(id) + 1)]));
        }
        case "definition":
        case "footnoteDefinition":
          return null;
        default:
          return node.children ? h("div", { key }, ...all(node)) : node.value != null ? text(node.value) : null;
      }
    }
    const body = wrap(all(tree));
    if (order.length) {
      const notes = order
        .filter((id) => footnotes.has(id))
        .map((id) => {
          const slug = encodeURIComponent(id.toLowerCase());
          const back = Array.from({ length: uses.get(id) ?? 1 }, (_, n) =>
            mdLink(`#user-content-fnref-${slug}${n ? `-${n + 1}` : ""}`, ["↩", n ? h("sup", { key: "n" }, String(n + 1)) : null], `b${n}`),
          );
          const content = all(footnotes.get(id));
          const last = footnotes.get(id).children.at(-1);
          if (last?.type === "paragraph" && content.length) {
            const p = content.at(-1);
            content[content.length - 1] = h("p", { key: p.key }, ...[p.props.children ?? []].flat(), " ", ...back);
          } else content.push(" ", ...back);
          return h("li", { key: id, id: `user-content-fn-${slug}` }, ...content);
        });
      body.push(
        h(
          "section",
          { key: "footnotes", "data-footnotes": "true", className: "footnotes" },
          h("h2", { className: "sr-only", id: "footnote-label" }, "Footnotes"),
          h("ol", null, ...notes),
        ),
      );
    }
    return body;
  }

  /** Buzz's InstructionsMarkdown: the document at its compact scale, or its
   * wrapped source past the size, depth or table limits. */
  function InstructionsMarkdown({ text }) {
    const tree = React.useMemo(() => parseInstructions(text), [text]);
    const classes = markdownClasses();
    if (!tree)
      return h(
        "div",
        { className: [classes.document, MD_CLASS].filter(Boolean).join(" ") },
        h("pre", { className: classes.source, style: classes.source ? undefined : { whiteSpace: "pre-wrap" } }, h("code", null, text)),
      );
    return h("div", { className: [classes.document, classes.compact, MD_CLASS].filter(Boolean).join(" ") }, ...renderMarkdown(tree, classes));
  }

  return { InstructionsMarkdown, markdownClasses, renderMarkdown };
}
