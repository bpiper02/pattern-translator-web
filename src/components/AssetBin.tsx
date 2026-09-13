import { Trash2 } from "lucide-react";
import { assetKindLabel, type ProjectAudioAsset } from "../project/assets";
import "../assetBin.css";

type AssetBinProps = {
  assets: ProjectAudioAsset[];
  onRemove: (id: string) => void;
  onClear: () => void;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AssetBin({ assets, onRemove, onClear }: AssetBinProps) {
  return (
    <section className="assetBin module" aria-label="Project asset bin">
      <div className="assetBinHeader">
        <div>
          <div className="moduleTitle">PROJECT BIN // CURRENT MATERIAL</div>
          <div className="assetBinHint">UPLOAD ONCE. SPLIT / RESAMPLE / TRANSLATE DERIVATIVES STAY AVAILABLE WHILE THIS SESSION IS OPEN.</div>
        </div>
        {assets.length > 0 && (
          <button className="utilityButton" onClick={onClear}>CLEAR BIN</button>
        )}
      </div>

      {!assets.length ? (
        <div className="assetBinEmpty">NO MATERIAL YET — ADD A SOURCE IN ANY WORKSPACE</div>
      ) : (
        <div className="assetBinRail">
          {assets.map((asset) => (
            <div className="assetCard" key={asset.id}>
              <div className="assetCardTop">
                <span className="assetKind">{assetKindLabel(asset.kind)}</span>
                <span className="assetOrigin">{asset.origin.toUpperCase()}</span>
              </div>
              <b title={asset.file.name}>{asset.label || asset.file.name}</b>
              <span className="assetMeta">{formatBytes(asset.file.size)} // {asset.parentId ? "DERIVED" : "SOURCE"}</span>
              <button className="assetRemove" aria-label={`Remove ${asset.label}`} onClick={() => onRemove(asset.id)}>
                <Trash2 size={12} /> REMOVE
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
