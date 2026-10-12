import { Panel } from '../common/panel'
import { SlideBuiltinTemplatesPanel } from './slide-builtin-templates'
import { SlideTemplatesPanel } from './slide-templates'

/**
 * "Desain" panel (Slide domain, under the outline): the two Daedalus-born
 * design sources merged into one panel instead of two stacked panels.
 * "Desain bawaan" picks the design language (layouts, ornaments,
 * typography) the outline is poured into; "Warna & Font" re-skins the
 * palette + typography over it. "Template impor" stays a separate panel —
 * an uploaded .pptx is the other design source, and the two are never
 * combined on one deck.
 */
export function SlideDesignPanel() {
  return (
    <Panel title="Desain" data-testid="slide-design-panel">
      <div className="flex flex-col gap-3">
        <SlideBuiltinTemplatesPanel bare />
        <SlideTemplatesPanel bare />
      </div>
    </Panel>
  )
}
