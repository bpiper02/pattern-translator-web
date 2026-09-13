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
  const flatness = clamp01((feature.flatnessDb + 60) / 60);
  const rolloff = clamp01(Math.log2(Math.max(40, feature.rolloffHz) / 40) / Math.log2(20_000 / 40));
  const zcr = clamp01(feature.zcr / 0.35);
  return [
    clamp01(feature.lowRatio) * 1.35,
    clamp01(feature.midLowRatio),
    clamp01(feature.midHighRatio),
    clamp01(feature.highRatio) * 1.35,
    flatness * 0.75,
    rolloff * 0.85,
    zcr * 0.75,
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

  // Kick: energy is concentrated in the low / low-mid body with a relatively
  // low rolloff. This intentionally does not require a specific pitch.
  if (
    mean.lowRatio + mean.midLowRatio * 0.45 >= upperEnergy * 1.15 &&
    mean.rolloffHz < 5_000
  ) return 0;

  // Hat/cymbal-like: high-frequency energy plus a high rolloff / crossing rate.
  if (
    mean.highRatio >= Math.max(0.16, mean.lowRatio * 1.15) &&
    mean.rolloffHz >= 5_500 &&
    mean.zcr >= 0.06
  ) return 3;

  // Snare/clap-like: broad/noisy upper-mid spectrum. Flatness closer to 0 dB
  // means more noise-like; -28 dB is deliberately permissive for processed snares.
  if (
    upperEnergy >= 0.38 &&
    mean.flatnessDb >= -28
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
