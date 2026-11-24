import { icon } from "./icons.js";
import { reportFailure } from "./session-element.js";

/** Fill `select` with `devices`, `selected` chosen; device labels are text only. */
export const fill = (select, devices, selected, name) => {
  select.replaceChildren(...devices.map((d, i) => new Option(d.label || `${name} ${i + 1}`, d.deviceId)));
  if (selected) select.value = selected;
  select.disabled = !devices.length;
};

/** Camera and microphone pickers, the microphone level and its volume, through `client.media`. */
class AmsDevices extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="field"><label for="ams-camera">Camera</label>
        <div class="input"><select id="ams-camera"></select>${icon("down")}</div></div>
      <div class="field"><label for="ams-microphone">Microphone</label>
        <div class="input"><select id="ams-microphone"></select>${icon("down")}</div>
        <div class="meter" aria-hidden="true"><i></i></div></div>
      <div class="field"><label for="ams-volume">Microphone volume</label>
        <input id="ams-volume" class="range" type="range" min="0" max="1" step="0.05" value="1"></div>`;
  }

  set client(client) {
    const { media } = client;
    // tell the page, and repaint the pickers from what the SDK still uses
    const failed = (action) => (e) => {
      reportFailure(this, action, e);
      media.listDevices().catch(() => {});
    };
    const [camera, microphone] = this.querySelectorAll("select");
    const volume = this.querySelector(".range");
    const level = this.querySelector(".meter i");
    camera.onchange = () => media.selectVideoInput(camera.value).catch(failed("selectVideoInput()"));
    microphone.onchange = () => media.selectAudioInput(microphone.value).catch(failed("selectAudioInput()"));
    volume.oninput = () => media.setVolumeLevel(Number(volume.value)).catch(failed("setVolumeLevel()"));
    // a no-op until a stream exists; once on, the SDK keeps it on the current microphone track
    const meter = () =>
      media
        .enableAudioLevelForLocalStream((v) => (level.style.width = `${Math.min(100, v * 400)}%`), 100)
        .catch(failed("enableAudioLevelForLocalStream()"));
    client.on("devices_updated", (devices) => {
      // without a selection, the device the track uses
      const used = (kind) => media.getLocalStream()?.getTracks().find((t) => t.kind === kind)?.getSettings().deviceId;
      fill(camera, devices.videoInputs, devices.selectedVideoInputId ?? used("video"), "Camera");
      fill(microphone, devices.audioInputs, devices.selectedAudioInputId ?? used("audio"), "Microphone");
      meter();
    });
    media.listDevices().catch(failed("listDevices()"));
  }
}

customElements.define("ams-devices", AmsDevices);
