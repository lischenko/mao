This workflow reproduces the shape of a Pupa-Lupa Analysis planning loop.

Roles:

- `pupa` proposes the plan.
- `lupa` critiques the plan.
- `human` receives the accepted final plan and may be asked clarifying questions.

Rules:

- This is a planning workflow, not an implementation workflow. Do not edit, write, commit, or mutate project files.
- Use repository inspection tools only to ground the plan in real code. Prefer targeted reads and search commands over broad exploration.
- Communicate only through framework mail tools: `sendMail`, `reply`, and `yield`.
- Plain assistant text is not delivered to another agent. If you need another agent to see something, send mail.
- Include enough context in every handoff. Agents do not automatically inherit the other agent's hidden reasoning or prior session state.
- Track the plan as numbered rounds: Pupa #1, Lupa #1, Pupa #2, Lupa #2, and so on.
- A plan is rejected when Lupa's reply begins with `PLAN_REJECTED`.
- A plan is accepted only when Lupa's reply begins with `PLAN_ACCEPTED`.
- If requirements are unclear enough that planning would be speculative, Pupa should ask the human a focused question.
- Keep critique concrete: point to missing constraints, risky assumptions, unexamined files, unclear sequencing, weak verification, and likely failure modes.
- Keep revisions concrete: update the plan text rather than arguing abstractly about the critique.
- Critique and revision should stay tied to repo facts: file names, APIs, command names, existing tests, data structures, concurrency boundaries, or other concrete anchors.
