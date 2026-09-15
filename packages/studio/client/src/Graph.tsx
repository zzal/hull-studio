import { isTier, type Blueprint } from "@hull/blueprint";
import { Background, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type Edge, type Node } from "@xyflow/react";
import { useEffect } from "react";
import type { RecommendationsResponse } from "./api.js";

// One node per intent, one edge per link labelled with its role. Tiers sit
// in the left column and the intents they may link to on the right; a link
// is drawn from a tier's handle to a target's, and the role is picked next.
export type Selection = { type: "intent"; name: string } | { type: "link"; tier: string; index: number };

type Props = {
  blueprint: Blueprint;
  recommendations?: RecommendationsResponse;
  selection?: Selection;
  onSelect: (selection: Selection | undefined) => void;
  onConnect: (tier: string, to: string) => void;
};

const rowHeight = 120;
const columnWidth = 380;

const isSelectedIntent = (selection: Selection | undefined, name: string) => selection?.type === "intent" && selection.name === name;
const isSelectedLink = (selection: Selection | undefined, tier: string, index: number) =>
  selection?.type === "link" && selection.tier === tier && selection.index === index;

export function Graph(props: Props) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}

// Refits the view whenever the set of intents changes, so a node added
// from the palette, or a pan that ran away, never leaves the graph empty.
function Refit({ layout }: { layout: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const timer = setTimeout(() => void fitView({ padding: 0.2 }), 0);
    return () => clearTimeout(timer);
  }, [layout, fitView]);
  return null;
}

function Flow({ blueprint, recommendations, selection, onSelect, onConnect }: Props) {
  const entries = Object.entries(blueprint.intents);
  const tiers = entries.filter(([, intent]) => isTier(intent));
  const targets = entries.filter(([, intent]) => !isTier(intent));
  const nodeFor = ([name, intent]: (typeof entries)[number], column: number, row: number): Node => {
    const recommended = recommendations?.intents[name]?.recommended;
    const differs = recommended !== undefined && recommended !== intent.resolution;
    const tier = isTier(intent);
    return {
      id: name,
      // A tier only starts links, a target only receives them.
      type: tier ? "input" : "output",
      position: { x: column * columnWidth, y: row * rowHeight },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      selected: isSelectedIntent(selection, name),
      data: {
        label: (
          <div className="intent">
            <strong>{name}</strong>
            <span className="kind">{intent.kind}</span>
            <span className="resolution">{intent.resolution}</span>
            {differs && <span className="hint">recommended: {recommended}</span>}
          </div>
        ),
      },
      className: differs ? "differs" : undefined,
    };
  };
  const nodes: Node[] = [...tiers.map((entry, row) => nodeFor(entry, 0, row)), ...targets.map((entry, row) => nodeFor(entry, 1, row))];

  const edges: Edge[] = entries.flatMap(([name, intent]) =>
    isTier(intent)
      ? (intent.links ?? []).map((link, index) => ({
          id: `${name}->${link.to}#${index}`,
          source: name,
          target: link.to,
          label: link.role,
          selected: isSelectedLink(selection, name, index),
          data: { tier: name, index },
        }))
      : [],
  );

  const connect = (connection: Connection) => {
    if (connection.source && connection.target) onConnect(connection.source, connection.target);
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      nodesDraggable={false}
      onNodeClick={(_, node) => onSelect({ type: "intent", name: node.id })}
      onEdgeClick={(_, edge) => onSelect({ type: "link", ...(edge.data as { tier: string; index: number }) })}
      onPaneClick={() => onSelect(undefined)}
      onConnect={connect}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Refit layout={entries.map(([name]) => name).join(",")} />
    </ReactFlow>
  );
}
