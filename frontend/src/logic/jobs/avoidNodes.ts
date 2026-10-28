import { usePersistentState } from '../persist';

const MAX = 16;
/** A node name as SLURM prints it (`damnii11`), as the backend accepts it. */
export const validNode = (n: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n);

/**
 * Nodes every new job avoids (`--exclude`), e.g. one that fails every job. Kept on this Mac for all
 * job types until removed, and always shown in New job, so it never applies unseen.
 */
export function useAvoidNodes() {
  const [nodes, setNodes] = usePersistentState<string[]>('avoidNodes', []);
  return {
    nodes,
    add: (name: string) => {
      const n = name.trim();
      if (validNode(n) && !nodes.includes(n) && nodes.length < MAX) setNodes([...nodes, n]);
    },
    remove: (name: string) => setNodes(nodes.filter((x) => x !== name)),
  };
}
