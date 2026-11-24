import { websocketURL } from "../common.js";
import { icon } from "./icons.js";

const { host, pathname } = new URL(websocketURL);

/** Top bar of the sample pages. Its theme switch is handled by theme.js. */
class AmsTopbar extends HTMLElement {
  connectedCallback() {
    const gallery = /\/(index\.html)?$/.test(location.pathname) ? ' aria-current="page"' : "";
    this.innerHTML = `
      <header class="bar">
        <a class="brand" href="index.html"><img src="img/logo-badge.png" alt="">Ant Media <small>WebRTC SDK</small></a>
        <nav class="nav"><a href="index.html"${gallery}>Samples</a><a href="https://antmedia.io">antmedia.io</a></nav>
        <span class="grow"></span>
        <span class="server" title="The server these samples talk to"><i class="dot"></i><span class="mono"></span></span>
        <button class="icon-btn" type="button" data-theme-toggle aria-label="Switch theme">${icon("sun")}</button>
      </header>`;
    // websocketURL can come from the query string: text only
    this.querySelector(".server .mono").textContent = `${host} / ${pathname.split("/")[1]}`;
  }
}

customElements.define("ams-topbar", AmsTopbar);
