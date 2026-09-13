import { useEffect, useState } from "react";
import { Info, Palette, RotateCcw, X } from "lucide-react";
import "../chopsticks-settings.css";

type Skin = "red" | "violet" | "acid" | "amber";
type Panel = "info" | "skin" | null;

const SKINS: { id: Skin; label: string; swatch: string }[] = [
  { id: "red", label: "Redline", swatch: "#e2231a" },
  { id: "violet", label: "Ultraviolet", swatch: "#8d46ff" },
  { id: "acid", label: "Acid", swatch: "#87d92f" },
  { id: "amber", label: "Amber", swatch: "#e49721" },
];

const DEFAULT_PAD = "#d92920";

function readSkin(): Skin {
  const value = window.localStorage.getItem("chopsticks.skin");
  return SKINS.some((skin) => skin.id === value) ? value as Skin : "red";
}

function readPadColor() {
  const value = window.localStorage.getItem("chopsticks.padColor");
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value! : DEFAULT_PAD;
}

export function UiDock() {
  const [panel, setPanel] = useState<Panel>(null);
  const [skin, setSkin] = useState<Skin>(readSkin);
  const [padColor, setPadColor] = useState(readPadColor);

  useEffect(() => {
    document.documentElement.dataset.csSkin = skin;
    window.localStorage.setItem("chopsticks.skin", skin);
  }, [skin]);

  useEffect(() => {
    document.documentElement.style.setProperty("--cs-pad", padColor);
    window.localStorage.setItem("chopsticks.padColor", padColor);
  }, [padColor]);

  function resetAppearance() {
    setSkin("red");
    setPadColor(DEFAULT_PAD);
    window.localStorage.removeItem("chopsticks.skin");
    window.localStorage.removeItem("chopsticks.padColor");
  }

  return (
    <div className="uiDock" aria-label="Chopsticks controls">
      <div className="uiDockButtons">
        <button type="button" className={panel === "info" ? "active" : ""} aria-label="Open Chopsticks info" onClick={() => setPanel((current) => current === "info" ? null : "info")}>
          <Info size={15} />
        </button>
        <button type="button" className={panel === "skin" ? "active" : ""} aria-label="Customize Chopsticks appearance" onClick={() => setPanel((current) => current === "skin" ? null : "skin")}>
          <Palette size={15} />
        </button>
      </div>

      {panel && (
        <section className="uiDockPanel" role="dialog" aria-label={panel === "info" ? "Chopsticks info" : "Chopsticks appearance"}>
          <div className="uiDockPanelHeader">
            <b>{panel === "info" ? "INFO" : "SKIN"}</b>
            <button type="button" aria-label="Close panel" onClick={() => setPanel(null)}><X size={14} /></button>
          </div>

          {panel === "info" ? (
            <div className="uiDockInfo">
              <p><b>CRATE</b> keeps your source and derived sounds available while this browser session is open. Ejecting a tool does not delete its Crate copy.</p>
              <p><b>TRANSFORM</b> changes BPM and pitch/key. Whole mixes can smear on larger key shifts; split stems first when you need cleaner control.</p>
              <p><b>SPLIT</b> uses the configured separator backend. HQ modes can take longer and may download large model files on the backend machine.</p>
              <p><b>SAMPLE</b> builds a kit and groove from audio. Working preview and WAV export use the same rendered audio buffer.</p>
              <p><b>VOICE → MIDI</b> works best with one clear hummed/sung note at a time, no backing track, in a quiet room.</p>
            </div>
          ) : (
            <div className="uiDockSkin">
              <span className="uiDockLabel">CHASSIS ACCENT</span>
              <div className="skinChoices">
                {SKINS.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className={skin === option.id ? "selected" : ""}
                    onClick={() => setSkin(option.id)}
                  >
                    <i style={{ background: option.swatch }} />
                    {option.label}
                  </button>
                ))}
              </div>

              <label className="padColorControl">
                <span className="uiDockLabel">SEQUENCER / PAD COLOR</span>
                <div>
                  <input type="color" value={padColor} onChange={(event) => setPadColor(event.target.value)} aria-label="Sequencer and pad color" />
                  <code>{padColor.toUpperCase()}</code>
                </div>
              </label>

              <button type="button" className="resetSkin" onClick={resetAppearance}><RotateCcw size={13} /> RESET DEFAULT</button>
              <small>Appearance settings are local to this browser and never change audio, project state, or exports.</small>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
