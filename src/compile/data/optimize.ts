import {MAIN} from '../../data';
import {flatten, hasIntersection, keys, vals} from '../../util';
import {AggregateNode} from './aggregate';
import {DataFlowNode, OutputNode} from './dataflow';
import {FacetNode} from './facet';
import {ParseNode} from './formatparse';
import {DataComponent} from './index';
import {BottomUpOptimizer, TopDownOptimizer} from './optimizer';
import * as optimizers from './optimizers';
import {SourceNode} from './source';
import {StackNode} from './stack';

export const FACET_SCALE_PREFIX = 'scale_';
export const MAX_OPTIMIZATION_RUNS = 5;

/**
 * Clones the subtree and ignores output nodes except for the leafs, which are renamed.
 */
function cloneSubtree(facet: FacetNode) {
  function clone(node: DataFlowNode): DataFlowNode[] {
    if (!(node instanceof FacetNode)) {
      const copy = node.clone();

      if (copy instanceof OutputNode) {
        const newName = FACET_SCALE_PREFIX + copy.getSource();
        copy.setSource(newName);

        facet.model.component.data.outputNodes[newName] = copy;
      } else if (copy instanceof AggregateNode || copy instanceof StackNode) {
        copy.addDimensions(facet.fields);
      }
      flatten(node.children.map(clone)).forEach((n: DataFlowNode) => (n.parent = copy));

      return [copy];
    }

    return flatten(node.children.map(clone));
  }
  return clone;
}

/**
 * Move facet nodes down to the next fork or output node. Also pull the main output with the facet node.
 * After moving down the facet node, make a copy of the subtree and make it a child of the main output.
 */
class MoveFacetDown extends TopDownOptimizer {
  public moveMainDownToFacet(node: DataFlowNode) {
    if (node instanceof OutputNode && node.type === MAIN) {
      if (node.numChildren() === 1) {
        const child = node.children[0];
        if (!(child instanceof FacetNode)) {
          this.setMutated();
          child.swapWithParent();
          this.moveMainDownToFacet(node);
        }
      }
    }
  }
  public optimize(node: DataFlowNode): boolean {
    if (node instanceof FacetNode) {
      if (node.numChildren() === 1 && !(node.children[0] instanceof OutputNode)) {
        // move down until we hit a fork or output node
        this.setMutated();
        const child = node.children[0];

        if (child instanceof AggregateNode || child instanceof StackNode) {
          child.addDimensions(node.fields);
        }

        child.swapWithParent();
        this.optimize(node);
      } else {
        // move main to facet

        this.moveMainDownToFacet(node.model.component.data.main);

        // replicate the subtree and place it before the facet's main node
        const copy: DataFlowNode[] = flatten(node.children.map(cloneSubtree(node)));
        copy.forEach(c => (c.parent = node.model.component.data.main));
      }
    } else {
      for (const child of node.children) {
        this.optimize(child);
      }
    }
    return this.mutatedFlag;
  }
}

/**
 * Remove nodes that are not required starting from a root.
 */
class RemoveUnnecessaryNodes extends TopDownOptimizer {
  public optimize(node: DataFlowNode): boolean {
    // remove output nodes that are not required
    if (node instanceof OutputNode && !node.isRequired()) {
      this.setMutated();
      node.remove();
    }
    for (const child of node.children) {
      this.optimize(child);
    }

    return this.mutatedFlag;
  }
}

/**
 * Return all leaf nodes.
 */
function getLeaves(roots: DataFlowNode[]) {
  const leaves: DataFlowNode[] = [];
  function append(node: DataFlowNode) {
    if (node.numChildren() === 0) {
      leaves.push(node);
    } else {
      node.children.forEach(append);
    }
  }

  roots.forEach(append);
  return leaves;
}

/**
 * Move parse nodes up to forks.
 */
export class MoveParseUp extends BottomUpOptimizer {
  public optimize(node: DataFlowNode): optimizers.OptimizerFlags {
    const parent = node.parent;
    // move parse up by merging or swapping
    if (node instanceof ParseNode) {
      if (parent instanceof SourceNode) {
        return this.flags;
      }

      if (parent.numChildren() > 1) {
        // don't move parse further up but continue with parent.
        this.setContinue();
        return this.flags;
      }

      if (parent instanceof ParseNode) {
        this.setMutated();
        parent.merge(node);
      } else {
        // don't swap with nodes that produce something that the parse node depends on (e.g. lookup)
        if (hasIntersection(parent.producedFields(), node.dependentFields())) {
          this.setContinue();
          return this.flags;
        }
        this.setMutated();
        node.swapWithParent();
      }
    }
    this.setContinue();
    return this.flags;
  }
}

/**
 * Inserts an Intermediate ParseNode containing all non-conflicting Parse fields and removes the empty ParseNodes
 */
export class MergeParse extends BottomUpOptimizer {
  public optimize(node: DataFlowNode): optimizers.OptimizerFlags {
    const parent = node.parent;
    if (parent === undefined) {
      return this.flags;
    }
    const parseChildren = parent.children.filter((x): x is ParseNode => x instanceof ParseNode);
    if (parseChildren.length > 1) {
      const commonParse = {};
      for (const parseNode of parseChildren) {
        const parse = parseNode.parse;
        for (const k of keys(parse)) {
          if (commonParse[k] === undefined) {
            commonParse[k] = parse[k];
          } else if (commonParse[k] !== parse[k]) {
            delete commonParse[k];
          }
        }
      }
      if (keys(commonParse).length !== 0) {
        this.setMutated();
        const mergedParseNode = new ParseNode(parent, commonParse);
        for (const parseNode of parseChildren) {
          for (const key of keys(commonParse)) {
            delete parseNode.parse[key];
          }
          parent.removeChild(parseNode);
          parseNode.parent = mergedParseNode;
          if (keys(parseNode.parse).length === 0) {
            parseNode.remove();
          }
        }
      }
    }
    this.setContinue();
    return this.flags;
  }
}

function optimizationDataflowHelper(dataComponent: DataComponent) {
  let roots: SourceNode[] = vals(dataComponent.sources);
  let mutatedFlag = false;

  // mutatedFlag should always be on the right side otherwise short circuit logic might cause the mutating method to not execute
  mutatedFlag =
    roots
      .map(node => {
        const x = new RemoveUnnecessaryNodes();
        return x.optimize(node);
      })
      .some(x => x === true) || mutatedFlag;

  // remove source nodes that don't have any children because they also don't have output nodes
  roots = roots.filter(r => r.numChildren() > 0);

  mutatedFlag =
    getLeaves(roots)
      .map(node => {
        const x = new optimizers.RemoveUnusedSubtrees();
        return x.optimizeNextFromLeaves(node);
      })
      .some(x => x === true) || mutatedFlag;

  roots = roots.filter(r => r.numChildren() > 0);

  mutatedFlag =
    getLeaves(roots)
      .map(node => {
        const x = new MoveParseUp();
        return x.optimizeNextFromLeaves(node);
      })
      .some(x => x === true) || mutatedFlag;

  mutatedFlag =
    getLeaves(roots)
      .map(node => {
        const x = new MergeParse();
        return x.optimizeNextFromLeaves(node);
      })
      .some(x => x === true) || mutatedFlag;

  mutatedFlag =
    getLeaves(roots)
      .map(node => {
        const x = new optimizers.RemoveDuplicateTimeUnits();
        return x.optimizeNextFromLeaves(node);
      })
      .some(x => x === true) || mutatedFlag;

  mutatedFlag =
    roots
      .map(node => {
        const x = new MoveFacetDown();
        return x.optimize(node);
      })
      .some(x => x === true) || mutatedFlag;
  mutatedFlag =
    roots
      .map(node => {
        const x = new optimizers.MergeIdenticalTransforms();
        return x.optimize(node);
      })
      .some(x => x === true) || mutatedFlag;

  keys(dataComponent.sources).forEach(s => {
    if (dataComponent.sources[s].numChildren() === 0) {
      delete dataComponent.sources[s];
    }
  });
  return mutatedFlag;
}

/**
 * Optimizes the dataflow of the passed in data component.
 */
export function optimizeDataflow(data: DataComponent) {
  for (let i = 0; i < MAX_OPTIMIZATION_RUNS; i++) {
    if (!optimizationDataflowHelper(data)) {
      break;
    }
  }
}
