import { useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { assetKindLabel, type ProjectAudioAsset } from "../project/assets";
import "../assetBin.css";

type AssetDestination = "split" | "resample" | "translate";

type AssetBinProps = {
  assets: ProjectAudioAsset[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onSend: (asset: ProjectAudioAsset, destination: AssetDestination) => void;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function canSplit(asset: ProjectAudioAsset) {
  return ["mix", "drums", "other", "translated", "render"].includes(asset.kind);
}

export function AssetBin({ assets, onRemove, onClear, onSend }: AssetBinProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <aside className={`assetBin module ${mobileOpen ? "mobileOpen" : ""}`} aria-label="Crate">
      <div className="assetBinHeader">
        <div>
          <div className="moduleTitle">CRATE</div>
          <div className="assetBinHint">Your sounds stay here while you switch tools.</div>
        </div>
        <div className="assetBinHeaderActions">
          <button
            className="crateToggle utilityButton"
            type="button"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {assets.length} {assets.length === 1 ? "SOUND" : "SOUNDS"}
          </button>
          {assets.length > 0 && (
            <button className="utilityButton clearCrate" type="button" onClick={onClear}>CLEAR</button>
          )}
        </div>
      </div>

      <div className="assetBinBody">
        {!assets.length ? (
          <div className="assetBinEmpty">Drop or split audio to start your crate.</div>
        ) : (
          <div className="assetBinRail">
            {assets.map((asset) => (
              <div className="assetCard" key={asset.id}>
                <div className="assetCardTop">
                  <span className="assetKind">{assetKindLabel(asset.kind)}</span>
                  <span className="assetOrigin">{asset.origin.toUpperCase()}</span>
                </div>
                <b title={asset.file.name}>{asset.label || asset.file.name}</b>
                <span className="assetMeta">{formatBytes(asset.file.size)} · {asset.parentId ? "DERIVED" : "SOURCE"}</span>
                <div className="assetSendRow">
                  <button type="button" onClick={() => onSend(asset, "resample")}><ArrowRight size={10} /> SAMPLE</button>
                  <button type="button" onClick={() => onSend(asset, "translate")}><ArrowRight size={10} /> TRANSFORM</button>
                  {canSplit(asset) && <button type="button" onClick={() => onSend(asset, "split")}><ArrowRight size={10} /> SPLIT</button>}
                </div>
                <button className="assetRemove" type="button" aria-label={`Remove ${asset.label}`} onClick={() => onRemove(asset.id)}>
                  <Trash2 size={12} /> REMOVE
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
