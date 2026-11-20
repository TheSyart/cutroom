// Expanded-body components per registry body kind.
import type { Component } from 'vue'
import AskQuestionView from './AskQuestionView.vue'
import ExitPlanView from './ExitPlanView.vue'
import GenericToolCard from './GenericToolCard.vue'
import SkillView from './SkillView.vue'
import VideoEditView from './VideoEditView.vue'
import type { ToolBodyKind } from './registry'

export const TOOL_BODIES: Readonly<Record<ToolBodyKind, Component>> = {
  ask: AskQuestionView,
  plan: ExitPlanView,
  skill: SkillView,
  video: VideoEditView,
  generic: GenericToolCard,
}
