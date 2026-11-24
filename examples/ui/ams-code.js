import { copy } from "./copy.js";
import { icon } from "./icons.js";

// comment, string, keyword, called name: the classes .c .s .k .f in ui.css
const token = /(\/\/.*)|("[^"]*")|\b(import|from|const|new|await)\b|(\w+)(?=\()/g;
const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const highlight = (code) =>
  escape(code).replace(token, (m, c, s, k) => `<span class="${c ? "c" : s ? "s" : k ? "k" : "f"}">${m}</span>`);

// drop blank edge lines and the common indentation
const dedent = (text) => {
  const lines = text.replace(/^\s*\n|\s+$/g, "").split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
};

/** Shows the page's own module script as a code sample, highlighted, with a copy button. */
class AmsCode extends HTMLElement {
  connectedCallback() {
    if (this.querySelector("pre")) return;
    const code = dedent(document.querySelector('script[type="module"]').textContent);
    this.innerHTML = `<button class="mini copy" type="button" aria-label="Copy code">${icon("copy")}</button><pre class="code"><code>${highlight(code)}</code></pre>`;
    this.querySelector("button").onclick = (e) => copy(e.currentTarget, code);
  }
}

customElements.define("ams-code", AmsCode);
