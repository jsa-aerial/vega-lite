import {Legend as VgLegend} from 'vega';
import {flatten, keys, stringify, vals} from '../../util';
import {Model} from '../model';
import {LegendComponent} from './component';
import {mergeLegendComponent} from './parse';

export function assembleLegends(model: Model): VgLegend[] {
  const legendComponentIndex = model.component.legends;
  const legendByDomain: {[domainHash: string]: LegendComponent[]} = {};

  for (const channel of keys(legendComponentIndex)) {
    const scaleComponent = model.getScaleComponent(channel);
    const domainHash = stringify(scaleComponent.domains);
    if (legendByDomain[domainHash]) {
      for (const mergedLegendComponent of legendByDomain[domainHash]) {
        const merged = mergeLegendComponent(mergedLegendComponent, legendComponentIndex[channel]);
        if (!merged) {
          // If cannot merge, need to add this legend separately
          legendByDomain[domainHash].push(legendComponentIndex[channel]);
        }
      }
    } else {
      legendByDomain[domainHash] = [legendComponentIndex[channel].clone()];
    }
  }

  const legends = flatten(vals(legendByDomain)).map((legendCmpt: LegendComponent) => legendCmpt.combine());

  // if we have many legends, set default direction to horizontal to get more compact layout
  if (legends.length > 1) {
    for (const legend of legends) {
      if (!legend.direction) {
        legend.direction = 'horizontal';
      }
    }
  }

  return legends;
}
