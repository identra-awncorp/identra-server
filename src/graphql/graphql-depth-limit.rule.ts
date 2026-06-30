import {
  ASTVisitor,
  FragmentDefinitionNode,
  GraphQLError,
  Kind,
  SelectionSetNode,
  ValidationContext
} from 'graphql';

export function createDepthLimitRule(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition(node) {
      const fragments = collectFragments(context);
      const depth = calculateDepth(node.selectionSet, fragments, new Set(), 0);

      if (depth > maxDepth) {
        context.reportError(
          new GraphQLError(`GraphQL query depth ${depth} exceeds max depth ${maxDepth}.`, {
            nodes: [node],
            extensions: {
              code: 'QUERY_DEPTH_LIMIT_EXCEEDED',
              maxDepth,
              depth
            }
          })
        );
      }
    }
  });
}

function collectFragments(context: ValidationContext): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();

  for (const definition of context.getDocument().definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  return fragments;
}

function calculateDepth(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  visitedFragments: Set<string>,
  currentDepth: number
): number {
  let deepest = currentDepth;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const nextDepth = currentDepth + 1;
      deepest = Math.max(deepest, nextDepth);

      if (selection.selectionSet) {
        deepest = Math.max(
          deepest,
          calculateDepth(selection.selectionSet, fragments, visitedFragments, nextDepth)
        );
      }
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(
        deepest,
        calculateDepth(selection.selectionSet, fragments, visitedFragments, currentDepth)
      );
    }

    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragmentName = selection.name.value;

      if (visitedFragments.has(fragmentName)) {
        continue;
      }

      const fragment = fragments.get(fragmentName);

      if (!fragment) {
        continue;
      }

      visitedFragments.add(fragmentName);
      deepest = Math.max(
        deepest,
        calculateDepth(fragment.selectionSet, fragments, visitedFragments, currentDepth)
      );
      visitedFragments.delete(fragmentName);
    }
  }

  return deepest;
}
