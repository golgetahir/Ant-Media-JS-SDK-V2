import { icon } from "./icons.js";

// Drawn thumbnails by `thumb` kind; each kind's gradient is .thumb-<kind> in ui.css.
const thumbs = {
  live: `<span class="t-live"><span class="pill-live"><i></i>LIVE</span></span><span class="bars">${"<b></b>".repeat(7)}</span>`,
  play: `<span class="t-play"><span>${icon("play")}</span></span><span class="t-track"></span>`,
  grid: `<span class="t-grid"><span>AY</span><span>PT</span><span>MK</span><span>+4</span></span>`,
  chat: `<span class="t-chat"><span>Did the file arrive?</span><span>Yes, 1 MB in one piece</span><span>Sending the next one</span></span>`,
  pip: `<span class="t-pip">${icon("mic")}</span>`,
  draw: `<svg class="t-draw" viewBox="0 0 320 200" preserveAspectRatio="none"><path d="M30 150c40-90 70 40 110-30s60-70 90-10 40 40 60-20"/></svg>`,
};

/** Gallery card for one samples.js entry, given through the `sample` property. */
class AmsSampleCard extends HTMLElement {
  connectedCallback() {
    const { title, description, tags, href, thumb, status } = this.sample;
    const ready = status === "ready";
    const chips = tags.map((tag) => `<span class="chip">${tag}</span>`).join("");
    const inner = `
      <div class="thumb thumb-${thumb}" aria-hidden="true">${thumbs[thumb]}</div>
      ${ready ? `<span class="card-go" aria-hidden="true">${icon("right")}</span>` : `<span class="soon-badge">Soon</span>`}
      <div class="card-body"><h3>${title}</h3><p>${description}</p>${chips && `<div class="tags">${chips}</div>`}</div>`;
    this.innerHTML = ready ? `<a class="card" href="${href}">${inner}</a>` : `<div class="card soon">${inner}</div>`;
  }
}

customElements.define("ams-sample-card", AmsSampleCard);
