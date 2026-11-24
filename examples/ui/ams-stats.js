import { SessionElement, isWaiting } from "./session-element.js";

const POINTS = 30;
const sum = (s, a, b) => (s[a] ?? 0) + (s[b] ?? 0);
const percent = (part, whole) => (whole > 0 ? (Math.max(0, part) / whole) * 100 : undefined);

// what each mode charts from two consecutive PeerStats, `seconds` apart
const modes = {
  publish: {
    charts: [
      ["bitrate", "Bitrate", "kbps"],
      ["fps", "Frame rate", "fps"],
      ["rtt", "Round trip", "ms"],
      ["loss", "Packet loss", "%"],
    ],
    hint: "Loss is lost ÷ sent packets per second, as the server reports them.",
    values(s, prev, seconds) {
      const sent = sum(s, "videoPacketsSent", "audioPacketsSent") - sum(prev, "videoPacketsSent", "audioPacketsSent");
      const lost = sum(s, "videoPacketsLost", "audioPacketsLost") - sum(prev, "videoPacketsLost", "audioPacketsLost");
      const rtt = s.currentRoundTripTime ?? s.videoRoundTripTime;
      return {
        bitrate: s.currentOutgoingBitrate,
        fps: seconds > 0 ? (s.framesEncoded - prev.framesEncoded) / seconds : undefined,
        rtt: rtt === undefined ? undefined : rtt * 1000,
        loss: percent(lost, sent),
      };
    },
  },
  viewer: {
    charts: [
      ["bitrate", "Bitrate", "kbps"],
      ["fps", "Frame rate", "fps"],
      ["loss", "Packet loss", "%"],
      ["jitter", "Jitter", "ms"],
    ],
    hint: "Frame rate counts decoded frames. Loss is lost ÷ (received + lost) packets over the second. Jitter is the video's.",
    values(s, prev, seconds) {
      const received = sum(s, "videoPacketsReceived", "audioPacketsReceived") - sum(prev, "videoPacketsReceived", "audioPacketsReceived");
      const lost = sum(s, "videoPacketsLost", "audioPacketsLost") - sum(prev, "videoPacketsLost", "audioPacketsLost");
      return {
        bitrate: s.currentIncomingBitrate,
        fps: seconds > 0 ? (s.framesDecoded - prev.framesDecoded) / seconds : undefined,
        loss: percent(lost, received + Math.max(0, lost)),
        jitter: s.videoJitter === undefined ? undefined : s.videoJitter * 1000,
      };
    },
  },
};

/**
 * Charts of a session, sampled once a second from getStats() while it is live: what is sent, or
 * with the `viewer` attribute what is received. Each sample is also dispatched as a `sample`
 * event: `{ width, height, frameRate }` of the video.
 */
class AmsStats extends SessionElement {
  #mode;
  #series = {};
  #prev = null;
  #timer;

  connectedCallback() {
    this.#mode = modes[this.hasAttribute("viewer") ? "viewer" : "publish"];
    const stat = ([key, title, unit]) => `
      <div class="stat" data-key="${key}"><small>${title}</small><strong>–<span>${unit}</span></strong>
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline/></svg></div>`;
    this.innerHTML = `
      <div class="stats">${this.#mode.charts.map(stat).join("")}</div>
      <p class="hint">Sampled every second from <span class="mono">session.getStats()</span> while the stream is live. ${this.#mode.hint}</p>`;
    this.paint();
  }

  listen() {
    this.#prev = null;
    for (const [key] of this.#mode.charts) this.#series[key] = [];
    for (const stat of this.querySelectorAll(".stat")) {
      stat.querySelector("strong").firstChild.nodeValue = "–";
      stat.querySelector("polyline").removeAttribute("points");
    }
    return [];
  }

  // reconnecting, waiting and ended hold the last values
  paint() {
    const live = this.session?.state === "live" && !isWaiting(this.session);
    if (live === !!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = live ? setInterval(() => this.#sample(), 1000) : undefined;
  }

  async #sample() {
    const session = this.session;
    const s = await session.getStats().catch(() => null);
    if (!s || session !== this.session) return;
    const prev = this.#prev ?? s;
    this.#prev = s;
    const values = this.#mode.values(s, prev, (s.currentTimestamp - prev.currentTimestamp) / 1000);
    this.dispatchEvent(new CustomEvent("sample", { detail: { width: s.frameWidth, height: s.frameHeight, frameRate: values.fps } }));
    for (const stat of this.querySelectorAll(".stat")) this.#draw(stat, values[stat.dataset.key]);
  }

  #draw(stat, value) {
    if (value === undefined || Number.isNaN(value)) return;
    const series = this.#series[stat.dataset.key];
    series.push(value);
    if (series.length > POINTS) series.shift();
    const max = Math.max(...series) * 1.2 || 1;
    const points = series.map((v, i) => `${(i / (POINTS - 1)) * 100},${28 - (v / max) * 26}`);
    stat.querySelector("polyline").setAttribute("points", points.join(" "));
    stat.querySelector("strong").firstChild.nodeValue = value.toFixed(stat.dataset.key === "loss" ? 1 : 0);
  }
}

customElements.define("ams-stats", AmsStats);
