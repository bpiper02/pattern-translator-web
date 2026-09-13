export type DrumTimbreFeatures = {
  id: string;
  lowRatio: number;
  midLowRatio: number;
  midHighRatio: number;
  highRatio: number;
  flatnessDb: number;
  rolloffHz: number;
  zcr: number;
};

export type DrumLane = 0 | 1 | 2 | 3; // KICK, SNARE, PERC, HAT

type Cluster = {
  members: number[];
  vector: number[];
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function featureVector(feature: DrumTimbreFeatures) {
  // Essentia's FlatnessDB output is documented as a flatness measure and in the
  // current extractor is observed in a compact ~0..1 range for these transient
  // windows. Keep it as a secondary similarity cue, not a hard drum-type rule.
  const flatness = clamp01(feature.flatnessDb);
  const rolloff = clamp01(Math.log2(Math.max(40, feature.rolloffHz) / 40) / Math.log2(20_000 / 40));
  const zcr = clamp01(feature.zcr / 0.55);
  return [
    clamp01(feature.lowRatio) * 1.45,
    clamp01(feature.midLowRatio) * 1.05,
    clamp01(feature.midHighRatio),
    clamp01(feature.highRatio) * 1.45,
    flatness * 0.45,
    rolloff * 0.80,
    zcr * 0.90,
  ];
}

function meanVector(vectors: number[][]) {
  if (!vectors.length) return [];
  return vectors[0].map((_, dimension) => (
    vectors.reduce((sum, vector) => sum + vector[dimension], 0) / vectors.length
  ));
}

function distance(a: number[], b: number[]) {
  return Math.sqrt(a.reduce((sum, value, index) => {
    const delta = value - b[index];
    return sum + delta * delta;
  }, 0));
}

function mergeClosest(clusters: Cluster[], vectors: number[][]) {
  let bestI = -1;
  let bestJ = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const candidate = distance(clusters[i].vector, clusters[j].vector);
      if (candidate < bestDistance) {
        bestDistance = candidate;
        bestI = i;
        bestJ = j;
      }
    }
  }

  if (bestI < 0 || bestJ < 0) return { clusters, distance: Number.POSITIVE_INFINITY };
  const members = [...clusters[bestI].members, ...clusters[bestJ].members];
  const merged: Cluster = {
    members,
    vector: meanVector(members.map((index) => vectors[index])),
  };
  return {
    distance: bestDistance,
    clusters: clusters.filter((_, index) => index !== bestI && index !== bestJ).concat(merged),
  };
}

function clusterMean(cluster: Cluster, features: DrumTimbreFeatures[]) {
  const members = cluster.members.map((index) => features[index]);
  const mean = (key: keyof Omit<DrumTimbreFeatures, "id">) => (
    members.reduce((sum, member) => sum + Number(member[key]), 0) / members.length
  );
  return {
    lowRatio: mean("lowRatio"),
    midLowRatio: mean("midLowRatio"),
    midHighRatio: mean("midHighRatio"),
    highRatio: mean("highRatio"),
    flatnessDb: mean("flatnessDb"),
    rolloffHz: mean("rolloffHz"),
    zcr: mean("zcr"),
  };
}

function laneForCluster(cluster: Cluster, features: DrumTimbreFeatures[]): DrumLane {
  const mean = clusterMean(cluster, features);
  const upperEnergy = mean.midHighRatio + mean.highRatio;

  // Kick-like: genuinely sub/low dominated. Requiring the low band itself to
  // dominate prevents midrange toms/percussion from being mislabeled as kicks.
  if (
    mean.lowRatio >= 0.20 &&
    mean.lowRatio >= mean.midLowRatio * 1.20 &&
    mean.lowRatio >= upperEnergy * 1.35 &&
    mean.rolloffHz < 5_000
  ) return 0;

  // Hat/cymbal-like: highest band strongly dominates the spectrum.
  if (
    mean.highRatio >= 0.30 &&
    mean.highRatio >= mean.midHighRatio * 1.35 &&
    mean.rolloffHz >= 5_500 &&
    mean.zcr >= 0.06
  ) return 3;

  // Snare/clap-like: broadband/noisy transient. A snare may still have a lot of
  // low-mid body, so use upper-band presence + rapid zero crossings rather than
  // demanding that the high band dominate like a hat.
  if (
    upperEnergy >= 0.24 &&
    mean.zcr >= 0.07 &&
    mean.rolloffHz >= 1_800
  ) return 1;

  return 2;
}

/**
 * Group acoustically similar hits within the current source before assigning
 * canonical UI lanes. Unlike quartile bucketing, identical hits stay together
 * even when the source contains only one or two drum types.
 */
export function classifyDrumTimbres(
  features: DrumTimbreFeatures[],
  maxClusters = 4,
  mergeThreshold = 0.34,
): DrumLane[] {
  if (!features.length) return [];
  const vectors = features.map(featureVector);
  let clusters: Cluster[] = vectors.map((vector, index) => ({ members: [index], vector }));

  while (clusters.length > 1) {
    const merged = mergeClosest(clusters, vectors);
    const mustReduce = clusters.length > Math.max(1, maxClusters);
    if (!mustReduce && merged.distance > mergeThreshold) break;
    clusters = merged.clusters;
  }

  const lanes: DrumLane[] = Array(features.length).fill(2) as DrumLane[];
  for (const cluster of clusters) {
    const lane = laneForCluster(cluster, features);
    for (const index of cluster.members) lanes[index] = lane;
  }
  return lanes;
}
