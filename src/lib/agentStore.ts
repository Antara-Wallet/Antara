/**
 * Local registry of agent vaults the user created. Stores ONLY public info
 * (agent address + vault address + label) so the Agents screen can list them and
 * show their on-chain activity. The agent private key is never stored here — the
 * user keeps it in their MCP config.
 */

export interface AgentRecord {
  id: string; // vault address, lowercased
  label: string;
  agentAddress: `0x${string}`;
  vaultAddress: `0x${string}`;
  chain: "ethereum" | "base"; // agents are always created on Base
  deployed?: boolean;
  createdAt: number;
}

const KEY = "ark.agents.v1";

function load(): AgentRecord[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as AgentRecord[];
  } catch {
    return [];
  }
}

function save(list: AgentRecord[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function listAgents(): AgentRecord[] {
  return load().sort((a, b) => b.createdAt - a.createdAt);
}

export function addAgent(r: Omit<AgentRecord, "id" | "createdAt">): AgentRecord {
  const list = load();
  const id = r.vaultAddress.toLowerCase();
  const existing = list.find((a) => a.id === id);
  const rec: AgentRecord = { ...r, id, createdAt: existing?.createdAt ?? Date.now() };
  save([rec, ...list.filter((a) => a.id !== id)]);
  return rec;
}

export function removeAgent(id: string): void {
  save(load().filter((a) => a.id !== id));
}
