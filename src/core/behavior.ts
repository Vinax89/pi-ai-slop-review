export interface BehaviorEvent {
  id: string;
  actorId: string;
  occurredAt: string;
  contentHash?: string;
  semanticHash?: string;
  domain?: string;
  templateKey?: string;
}

export interface BehaviorCluster {
  id: string;
  eventIds: string[];
  actorIds: string[];
  domains: string[];
  synchronizedPairs: number;
  synchronizedPairsByDomain?: Record<string, number>;
  sharedSignal: "content-hash" | "semantic-hash" | "template" | "time-only";
  confidence: "low" | "medium" | "high";
}

export interface BehaviorClusteringOptions {
  windowMs?: number;
  minClusterSize?: number;
}

export interface BehaviorInputDiagnostics {
  accepted: number;
  rejected: number;
  duplicateIds: string[];
  reasons: string[];
}

export interface DomainPattern {
  domain: string;
  eventCount: number;
  actorCount: number;
  uniqueContentHashes: number;
  repeatedContentRate: number;
  synchronizedPairCount: number;
  clusterIds: string[];
}

function validTime(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function inspectBehaviorEvents(events: BehaviorEvent[]): BehaviorInputDiagnostics {
  const reasons = new Set<string>();
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  let accepted = 0;
  for (const event of events) {
    if (!event.id) reasons.add("event id is missing");
    else if (seenIds.has(event.id)) {
      duplicateIds.add(event.id);
      reasons.add("event id is duplicated");
    } else {
      seenIds.add(event.id);
      if (!event.actorId) reasons.add("actor id is missing");
      else if (validTime(event.occurredAt) === undefined) reasons.add("occurredAt is not a valid timestamp");
      else accepted += 1;
    }
  }
  return { accepted, rejected: events.length - accepted, duplicateIds: [...duplicateIds].sort(), reasons: [...reasons].sort() };
}


function confidenceFor(signal: BehaviorCluster["sharedSignal"], synchronizedPairs: number): BehaviorCluster["confidence"] {
  if (signal === "content-hash" && synchronizedPairs >= 2) return "high";
  if (signal === "semantic-hash" || signal === "template") return "medium";
  return "low";
}

export function clusterBehaviorEvents(events: BehaviorEvent[], options: BehaviorClusteringOptions = {}): BehaviorCluster[] {
  const requestedWindow = options.windowMs ?? 15 * 60 * 1000;
  const requestedClusterSize = options.minClusterSize ?? 2;
  const windowMs = Number.isFinite(requestedWindow) ? Math.max(1, requestedWindow) : 15 * 60 * 1000;
  const minClusterSize = Number.isFinite(requestedClusterSize) ? Math.max(2, Math.floor(requestedClusterSize)) : 2;
  const seenIds = new Set<string>();
  const validRecords = events
    .map((event) => ({ event, time: validTime(event.occurredAt) }))
    .filter(({ event, time }) => event.id && !seenIds.has(event.id) && seenIds.add(event.id) && event.actorId && time !== undefined)
    .sort((left, right) => (left.time as number) - (right.time as number) || left.event.id.localeCompare(right.event.id));
  const valid = validRecords.map(({ event }) => event);
  const times = validRecords.map(({ time }) => time as number);
  const parent = valid.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const join = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  type Signal = Exclude<BehaviorCluster["sharedSignal"], "time-only">;
  type Bucket = { queue: number[]; head: number; byActor: Map<string, number> };
  const buckets = new Map<string, Bucket>();
  const edges = new Map<string, Signal>();
  const priority: Signal[] = ["content-hash", "semantic-hash", "template"];
  const priorityRank: Record<Signal, number> = { "content-hash": 0, "semantic-hash": 1, template: 2 };
  const processSignal = (key: string | undefined, signal: Signal, index: number): void => {
    if (!key) return;
    const bucketKey = `${signal}\u0000${key}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { queue: [], head: 0, byActor: new Map<string, number>() };
      buckets.set(bucketKey, bucket);
    }
    const now = times[index];
    while (bucket.head < bucket.queue.length && times[bucket.queue[bucket.head]] < now - windowMs) {
      const expired = bucket.queue[bucket.head];
      if (bucket.byActor.get(valid[expired].actorId) === expired) bucket.byActor.delete(valid[expired].actorId);
      bucket.head += 1;
    }
    let candidate: number | undefined;
    for (const [actorId, candidateIndex] of bucket.byActor) {
      if (actorId !== valid[index].actorId) {
        candidate = candidateIndex;
        break;
      }
    }
    if (candidate !== undefined) {
      join(candidate, index);
      const edgeKey = candidate < index ? `${candidate}:${index}` : `${index}:${candidate}`;
      const existing = edges.get(edgeKey);
      if (!existing || priorityRank[signal] < priorityRank[existing]) edges.set(edgeKey, signal);
    }
    bucket.byActor.set(valid[index].actorId, index);
    bucket.queue.push(index);
  };
  for (let index = 0; index < valid.length; index += 1) {
    processSignal(valid[index].contentHash, "content-hash", index);
    processSignal(valid[index].semanticHash, "semantic-hash", index);
    processSignal(valid[index].templateKey, "template", index);
  }
  const groups = new Map<number, number[]>();
  valid.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  });
  return [...groups.values()]
    .filter((group) => new Set(group.map((index) => valid[index].actorId)).size >= minClusterSize)
    .map((group, index) => {
      const members = new Set(group);
      const signalCounts: Record<Signal, number> = { "content-hash": 0, "semantic-hash": 0, template: 0 };
      const synchronizedPairsByDomain: Record<string, number> = {};
      let synchronizedPairs = 0;
      for (const [edgeKey, signal] of edges) {
        const [left, right] = edgeKey.split(":").map(Number);
        if (!members.has(left) || !members.has(right)) continue;
        synchronizedPairs += 1;
        signalCounts[signal] += 1;
        const domain = valid[left].domain;
        if (domain && domain === valid[right].domain) synchronizedPairsByDomain[domain] = (synchronizedPairsByDomain[domain] ?? 0) + 1;
      }
      const sharedSignal = priority.reduce((best, signal) => signalCounts[signal] > signalCounts[best] ? signal : best, "content-hash" as Signal);
      return {
        id: `cluster-${index + 1}`,
        eventIds: group.map((member) => valid[member].id).sort(),
        actorIds: [...new Set(group.map((member) => valid[member].actorId))].sort(),
        domains: [...new Set(group.map((member) => valid[member].domain).filter((domain): domain is string => Boolean(domain)))].sort(),
        synchronizedPairs,
        synchronizedPairsByDomain,
        sharedSignal: synchronizedPairs ? sharedSignal : "time-only",
        confidence: confidenceFor(synchronizedPairs ? sharedSignal : "time-only", signalCounts["content-hash"]),
      };
    });
}

export function reportDomainPatterns(events: BehaviorEvent[], clusters: BehaviorCluster[] = clusterBehaviorEvents(events)): DomainPattern[] {
  const clusterByEvent = new Map<string, string[]>();
  for (const cluster of clusters) {
    for (const eventId of cluster.eventIds) {
      const ids = clusterByEvent.get(eventId);
      if (ids) ids.push(cluster.id);
      else clusterByEvent.set(eventId, [cluster.id]);
    }
  }
  const seenIds = new Set<string>();
  const validEvents = events.filter((event) => event.id && !seenIds.has(event.id) && seenIds.add(event.id) && event.actorId && validTime(event.occurredAt) !== undefined);
  const domains = new Map<string, BehaviorEvent[]>();
  for (const event of validEvents) {
    if (!event.domain) continue;
    const domainEvents = domains.get(event.domain);
    if (domainEvents) domainEvents.push(event);
    else domains.set(event.domain, [event]);
  }
  return [...domains.entries()].map(([domain, domainEvents]) => {
    const hashes = new Set<string>();
    let hashCount = 0;
    const actorIds = new Set<string>();
    const clusterIds = new Set<string>();
    for (const event of domainEvents) {
      actorIds.add(event.actorId);
      if (event.contentHash) {
        hashes.add(event.contentHash);
        hashCount += 1;
      }
      for (const clusterId of clusterByEvent.get(event.id) ?? []) clusterIds.add(clusterId);
    }
    const uniqueHashes = hashes.size;
    return {
      domain,
      eventCount: domainEvents.length,
      actorCount: actorIds.size,
      uniqueContentHashes: uniqueHashes,
      repeatedContentRate: hashCount ? 1 - uniqueHashes / hashCount : 0,
      synchronizedPairCount: clusters.reduce((sum, cluster) => sum + (cluster.synchronizedPairsByDomain?.[domain] ?? (cluster.domains.length === 1 && cluster.domains[0] === domain ? cluster.synchronizedPairs : 0)), 0),
      clusterIds: [...clusterIds].sort(),
    };
  }).sort((left, right) => right.eventCount - left.eventCount || left.domain.localeCompare(right.domain));
}
