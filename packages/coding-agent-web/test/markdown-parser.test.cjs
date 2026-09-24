const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/static/app.js"), "utf8");

// Extract helper functions needed for markdown rendering
const names = [
	"el", "renderInline", "codeBlock", "isTableSeparator", "splitTableRow",
	"renderMarkdown", "renderMarkdownInto",
];

const bodies = names.map((name) => {
	const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
	assert.ok(match, `Missing function: ${name}`);
	return match[0];
}).join("\n");

// Also extract INLINE_MD
const inlineMdMatch = source.match(/const INLINE_MD =[^;]+;/);
assert.ok(inlineMdMatch, "Missing INLINE_MD");

function createMockElement(tag, cls, text) {
	const children = [];
	const classList = new Set(cls ? cls.split(" ").filter(Boolean) : []);
	return {
		tagName: tag.toUpperCase(),
		className: cls || "",
		textContent: text || "",
		children,
		dataset: {}, style: {}, align: "",
		classList: {
			add: (c) => classList.add(c),
			remove: (c) => classList.delete(c),
			contains: (c) => classList.has(c),
			toggle: (c, v) => (v ?? !classList.has(c)) ? classList.add(c) : classList.delete(c),
		},
		append: (...items) => {
			for (const item of items) {
				if (typeof item === "string") {
					children.push({ text: item });
				} else {
					children.push(item);
				}
			}
		},
		replaceChildren: (...items) => {
			children.length = 0;
			for (const item of items) {
				if (item && item.children) children.push(...item.children);
				else if (item) children.push(item);
			}
		},
		querySelector: () => null,
		querySelectorAll: () => [],
	};
}

function harness() {
	const ctx = vm.createContext({
		console,
		document: {
			createDocumentFragment: () => {
				const frag = createMockElement("fragment");
				return frag;
			},
			createTextNode: (text) => ({ text }),
			createElement: (tag) => {
				const elObj = createMockElement(tag, "");
				return elObj;
			},
		},
		navigator: {},
	});
	vm.runInContext(`${inlineMdMatch[0]}\nfunction el(tag, cls, text) {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text) node.textContent = text;
		return node;
	}\n${bodies}`, ctx);
	return ctx;
}

test("markdown links have correct href and textContent (not inverted)", () => {
	const ctx = harness();
	const parent = createMockElement("div");
	ctx.renderInline(parent, "[Documentation](https://primeintellect.ai)");
	const link = parent.children.find((c) => c.tagName === "A");
	assert.ok(link, "Expected an <a> element");
	assert.equal(link.href, "https://primeintellect.ai");
	assert.equal(link.children[0].text, "Documentation");
});

test("markdown bold-italic ***text*** renders properly without stray asterisks", () => {
	const ctx = harness();
	const parent = createMockElement("div");
	ctx.renderInline(parent, "This is ***bold and italic*** text.");
	const strong = parent.children.find((c) => c.tagName === "STRONG");
	assert.ok(strong, "Expected <strong> element");
	const em = strong.children.find((c) => c.tagName === "EM");
	assert.ok(em, "Expected <em> element inside <strong>");
	assert.equal(em.children[0].text, "bold and italic");
	assert.equal(parent.children.some((c) => c.text && c.text.includes("***")), false);
});

test("nested inline code inside bold renders code element", () => {
	const ctx = harness();
	const parent = createMockElement("div");
	ctx.renderInline(parent, "**Run `npm test` now**");
	const strong = parent.children.find((c) => c.tagName === "STRONG");
	assert.ok(strong);
	const code = strong.children.find((c) => c.tagName === "CODE");
	assert.ok(code, "Expected inline code element inside strong");
	assert.equal(code.textContent, "npm test");
});

test("underscore bold and italic work while preserving snake_case", () => {
	const ctx = harness();
	const parent = createMockElement("div");
	ctx.renderInline(parent, "Use __bold__ and _italic_ with variable_name_here");
	const strong = parent.children.find((c) => c.tagName === "STRONG");
	const em = parent.children.find((c) => c.tagName === "EM");
	assert.ok(strong, "Expected __bold__");
	assert.ok(em, "Expected _italic_");
	const snakeText = parent.children.find((c) => c.text && c.text.includes("variable_name_here"));
	assert.ok(snakeText, "Expected snake_case to remain as plain text");
});

test("autolinks convert raw URLs and preserve trailing punctuation", () => {
	const ctx = harness();
	const parent = createMockElement("div");
	ctx.renderInline(parent, "Visit https://example.com/docs. Great site!");
	const link = parent.children.find((c) => c.tagName === "A");
	assert.ok(link);
	assert.equal(link.href, "https://example.com/docs");
	assert.equal(link.textContent, "https://example.com/docs");
	const hasDot = parent.children.some((c) => c.text === ".");
	assert.ok(hasDot, "Trailing dot should be preserved as separate text node");
});

test("code block with attributes parses language and code", () => {
	const ctx = harness();
	const fragment = ctx.renderMarkdown("```typescript filename=\"app.ts\"\nconst a = 1;\n```");
	const codeblock = fragment.children.find((c) => c.className === "codeblock");
	assert.ok(codeblock, "Expected codeblock element");
	const codeEl = codeblock.children.find((c) => c.tagName === "PRE")?.children?.find((c) => c.tagName === "CODE");
	assert.equal(codeEl?.textContent, "const a = 1;");
});

test("tables with pipe inside inline code do not split cells incorrectly", () => {
	const ctx = harness();
	const md = [
		"| Command | Syntax | Description |",
		"| --- | --- | --- |",
		"| Search | `cat file | grep text` | Search file |",
	].join("\n");
	const fragment = ctx.renderMarkdown(md);
	const tableWrap = fragment.children.find((c) => c.className === "md-table-wrap");
	assert.ok(tableWrap);
	const table = tableWrap.children.find((c) => c.tagName === "TABLE");
	const rows = table.children.filter((c) => c.tagName === "TR");
	assert.equal(rows.length, 2); // 1 header row + 1 data row
	const dataRow = rows[1];
	const tds = dataRow.children.filter((c) => c.tagName === "TD");
	assert.equal(tds.length, 3, "Table should have exactly 3 columns even with pipe in code");
});

test("task list renders checkbox", () => {
	const ctx = harness();
	const md = "- [ ] Unfinished task\n- [x] Finished task";
	const fragment = ctx.renderMarkdown(md);
	const ul = fragment.children.find((c) => c.tagName === "UL");
	assert.ok(ul);
	const lis = ul.children.filter((c) => c.tagName === "LI");
	assert.equal(lis.length, 2);
	const cb1 = lis[0].children.find((c) => c.tagName === "INPUT");
	const cb2 = lis[1].children.find((c) => c.tagName === "INPUT");
	assert.ok(cb1 && cb1.type === "checkbox" && !cb1.checked);
	assert.ok(cb2 && cb2.type === "checkbox" && cb2.checked);
});

test("headings h1 through h6 are parsed with proper md-h class", () => {
	const ctx = harness();
	const md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6";
	const fragment = ctx.renderMarkdown(md);
	const headings = fragment.children.filter((c) => c.className === "md-h");
	assert.equal(headings.length, 6, "All 6 heading levels should be parsed");
});

test("blockquotes with multiple lines render with line breaks", () => {
	const ctx = harness();
	const md = "> First line\n> Second line";
	const fragment = ctx.renderMarkdown(md);
	const quote = fragment.children.find((c) => c.tagName === "BLOCKQUOTE");
	assert.ok(quote);
	const hasBr = quote.children.some((c) => c.tagName === "BR");
	assert.ok(hasBr, "Multi-line blockquotes should insert <br> between lines");
});

test("ordered lists with blank lines remain a single <ol> with consecutive items", () => {
	const ctx = harness();
	const md = "1. Step one\n\n2. Step two\n\n3. Step three";
	const fragment = ctx.renderMarkdown(md);
	const ols = fragment.children.filter((c) => c.tagName === "OL");
	assert.equal(ols.length, 1, "Loose ordered list with blank lines must not be split into multiple <ol>");
	const lis = ols[0].children.filter((c) => c.tagName === "LI");
	assert.equal(lis.length, 3, "Expected 3 items in the single <ol>");
});

test("ordered lists starting at non-1 preserve start attribute", () => {
	const ctx = harness();
	const md = "5. Step five\n6. Step six";
	const fragment = ctx.renderMarkdown(md);
	const ol = fragment.children.find((c) => c.tagName === "OL");
	assert.ok(ol);
	assert.equal(ol.start, 5, "Expected <ol start='5'>");
	assert.equal(ol.children.length, 2);
});

test("nested sub-lists render inside parent <li> instead of breaking numbering", () => {
	const ctx = harness();
	const md = [
		"1. Poin utama satu",
		"   - Sub-poin A",
		"   - Sub-poin B",
		"2. Poin utama dua",
		"   1. Sub-angka 1",
		"   2. Sub-angka 2",
		"3. Poin utama tiga",
	].join("\n");
	const fragment = ctx.renderMarkdown(md);
	const ols = fragment.children.filter((c) => c.tagName === "OL");
	assert.equal(ols.length, 1, "Top-level list should be a single <ol>");
	const lis = ols[0].children.filter((c) => c.tagName === "LI");
	assert.equal(lis.length, 3, "Top-level <ol> should have exactly 3 items (1, 2, 3)");
	
	// Check nested ul in first li
	const nestedUl = lis[0].children.find((c) => c.tagName === "UL");
	assert.ok(nestedUl, "Item 1 should contain a nested <ul>");
	assert.equal(nestedUl.children.length, 2, "Nested <ul> should have 2 sub-items");

	// Check nested ol in second li
	const nestedOl = lis[1].children.find((c) => c.tagName === "OL");
	assert.ok(nestedOl, "Item 2 should contain a nested <ol>");
	assert.equal(nestedOl.children.length, 2, "Nested <ol> should have 2 sub-items");
});

test("bold containing italic (*text*) parses strong with nested em without breaking", () => {
	const ctx = harness();
	const parent = createMockElement("div");
	ctx.renderInline(parent, "**Masalah Baris Kosong (*Loose Lists*)**:");
	const strong = parent.children.find((c) => c.tagName === "STRONG");
	assert.ok(strong, "Expected outer <strong> element");
	const em = strong.children.find((c) => c.tagName === "EM");
	assert.ok(em, "Expected inner <em> element");
	assert.equal(em.children[0].text, "Loose Lists");
	assert.equal(parent.children.some((c) => c.text && c.text.includes("*")), false, "No stray asterisks");
});

test("loose asterisks in math or spacing (* *) are not treated as italic", () => {
	const ctx = harness();
	const parent = createMockElement("div");
	ctx.renderInline(parent, "Formula: a * b * c or bold * * should stay as plain text");
	const em = parent.children.find((c) => c.tagName === "EM");
	assert.equal(em, undefined, "Asterisks surrounded by spaces must not trigger italic");
});

test("block math $$...$$ parses into .math-block and preserves formula", () => {
	const ctx = harness();
	const md = "$$\\text{Cost Input} = \\frac{\\text{Harga}}{1000} \\times \\text{Token}$$";
	const fragment = ctx.renderMarkdown(md);
	const mathBlock = fragment.children.find((c) => c.className === "math-block");
	assert.ok(mathBlock, "Expected .math-block element");
	assert.ok(mathBlock.textContent.includes("Cost Input"), "Math content should be preserved");
	assert.ok(mathBlock.textContent.includes("frac"), "Math latex code should be preserved");
});

test("inline math $...$ inside paragraph parses into .math-inline", () => {
	const ctx = harness();
	const parent = createMockElement("div");
	ctx.renderInline(parent, "Rumus $E = mc^2$ sangat terkenal.");
	const mathSpan = parent.children.find((c) => c.className === "math-inline");
	assert.ok(mathSpan, "Expected .math-inline element");
	assert.ok(mathSpan.textContent.includes("E = mc^2"));
});

test("tables with alignment colons apply style.textAlign to headers and cells", () => {
	const ctx = harness();
	const md = [
		"| Left | Center | Right |",
		"| :--- | :---: | ---: |",
		"| A | B | C |",
	].join("\n");
	const fragment = ctx.renderMarkdown(md);
	const table = fragment.children.find((c) => c.className === "md-table-wrap")?.children?.find((c) => c.tagName === "TABLE");
	assert.ok(table);
	const ths = table.children[0].children.filter((c) => c.tagName === "TH");
	assert.equal(ths[0].style.textAlign, "left");
	assert.equal(ths[1].style.textAlign, "center");
	assert.equal(ths[2].style.textAlign, "right");
	const tds = table.children[1].children.filter((c) => c.tagName === "TD");
	assert.equal(tds[0].style.textAlign, "left");
	assert.equal(tds[1].style.textAlign, "center");
	assert.equal(tds[2].style.textAlign, "right");
});
