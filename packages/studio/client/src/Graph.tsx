import type { Blueprint } from "@hull/blueprint";
import { Background, Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { RecommendationsResponse } from "./api.js";

// One node per intent, one edge per link labelled with its role. Intents are
// laid out left to right in blueprint order; links go from the tier to what
// it uses.
const columnWidth = 260;

export function Graph({ blueprint, recommendations }: { blueprint: Blueprint; recommendations?: RecommendationsResponse }) {
  const nodes: Node[] = Object.entries(blueprint.intents).map(([name, intent], index) => {
    const recommended = recommendations?.intents[name]?.recommended;
    const differs = recommended !== undefined && recommended !== intent.resolution;
    return {
      id: name,
      position: { x: index * columnWidth, y: 80 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
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
  });

  const edges: Edge[] = Object.entries(blueprint.intents).flatMap(([name, intent]) =>
    intent.kind === "http-api"
      ? (intent.links ?? []).map((link) => ({
          id: `${name}->${link.to}`,
          source: name,
          target: link.to,
          label: link.role,
        }))
      : [],
  );

  return (
    <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
      <Background />
    </ReactFlow>
  );
}
