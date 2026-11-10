// The deployment record (addresses, deploy block, demo sellers). Locally it is read from
// deployments/<chainId>.json; in the Cloudflare Worker it is bundled and set at startup.

export interface Deployment {
  chainId?: number;
  deployBlock?: number;
  contracts?: Record<string, string | null>;
  sellers?: { name: string; address: string; agentId: string | null; resource: string }[];
}

let current: Deployment = { sellers: [] };

export function setDeployment(d: Deployment) {
  current = d ?? { sellers: [] };
}

export function getDeployment(): Deployment {
  return current;
}
