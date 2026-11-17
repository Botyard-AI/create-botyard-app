// Who approves: the reviewer bot and the people for each role. One small JSON
// file next to the quotes, kept when the demo is reset.
import type { DeskSettings, HumanRole } from "../../shared/types.ts"
import { HUMAN_ROLES } from "../../shared/types.ts"

export const EMPTY_SETTINGS: DeskSettings = {
  reviewer_bot: null,
  review_board: null,
  handoff_thread: null,
  approvers: { finance: [], business: [] },
}

export type SettingsOptions = {
  /** The stored settings; null or absent starts empty. */
  settings?: DeskSettings | null
  /** Persists the settings. Throws to refuse the change. */
  save?: (settings: DeskSettings) => void
}

export class SettingsStore {
  #settings: DeskSettings
  readonly #save: (settings: DeskSettings) => void

  constructor(options: SettingsOptions = {}) {
    this.#settings = options.settings ?? EMPTY_SETTINGS
    this.#save = options.save ?? (() => undefined)
  }

  get(): DeskSettings {
    return this.#settings
  }

  /** Saves, then publishes: a failed save changes nothing. */
  set(settings: DeskSettings): DeskSettings {
    this.#save(settings)
    this.#settings = settings
    return settings
  }

  /** The roles a member may decide for, by user id: an email can move to someone else. */
  rolesOf(userId: string): HumanRole[] {
    return HUMAN_ROLES.filter((role) => this.#settings.approvers[role].includes(userId))
  }
}
