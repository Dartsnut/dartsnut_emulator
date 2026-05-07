## 1. Intake Flow Orchestration

- [ ] 1.1 Add a pre-creation intake state machine that resolves required inputs in order: project type, conditional widget size, workspace selection, and workspace validation
- [ ] 1.2 Skip intake prompts for fields already present in the initial user request while preserving the same validation rules
- [ ] 1.3 Build a normalized creation context payload (`type`, optional `widgetSize`, `workspacePath`) for downstream template routing

## 2. Project Type and Widget Size Validation

- [ ] 2.1 Implement project type resolution that accepts only `game` or `widget`, and prompts when missing
- [ ] 2.2 Implement widget size handling for widget flows that accepts only `128x160`, `128x128`, `128x64`, or `64x32`
- [ ] 2.3 Add explicit rejection and reprompt behavior for unsupported widget size values

## 3. Workspace Folder Selection and Checks

- [ ] 3.1 Implement a workspace-folder selection prompt when no workspace is selected
- [ ] 3.2 Add folder emptiness validation before creation starts
- [ ] 3.3 Add rejection and reprompt behavior when the chosen folder is not empty

## 4. Creator Template Routing

- [ ] 4.1 Route resolved `game` requests to the game-creator template only after workspace validation succeeds
- [ ] 4.2 Route resolved `widget` requests to the widget-creator template only after widget size and workspace validation succeed
- [ ] 4.3 Ensure template invocations receive the normalized creation context payload without re-asking for already collected data

## 5. Verification

- [ ] 5.1 Add/extend tests for missing project type prompt behavior
- [ ] 5.2 Add/extend tests for widget size selection, including unsupported-size reprompt paths
- [ ] 5.3 Add/extend tests for non-empty workspace rejection and empty-workspace acceptance
- [ ] 5.4 Add/extend tests for successful routing to game-creator and widget-creator templates
