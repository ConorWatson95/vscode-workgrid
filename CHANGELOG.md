# Changelog

All notable changes to Task Workspaces are documented here.

## 0.115.3

- **An evidence-certified gate booked itself as an operator approval.** `counted` records
  an intervention whenever it is given a clock, and the runner has to give it one — so
  the first gate the harness passed on its own was filed as a human having approved it.

  That is the worst place this could be wrong. `interventions` is the measurement that
  justified building the mechanism: 320 approvals, 271 of them on stages that were not
  authority boundaries. Counting every automatic pass as an approval keeps the number
  flat by construction, so the improvement would be invisible in exactly the analysis
  anyone would run to check it — and the next audit of that data would conclude the
  feature did nothing.

  `approveStage` now takes an actor. `"harness"` records no intervention; everything else
  about the transition is identical, because an automatic pass still has to clear the
  checklist, the operator's outstanding actions and plan-step accounting.

  Caught on the first live evidence gate, which passed correctly and then mis-booked
  itself. One approval recorded before this fix is a false positive.

## 0.115.2

- **A task with an agent working on it was filed under "Needs you."** `groupForTask`
  returned `needs-you` for any `awaiting-approval` stage anywhere in the route, and that
  check ran *before* the `active` one — so a task whose plan had been corrected, with the
  amendment for its implementation stage running, was filed as needing a decision because
  a review further down the route was still holding from before. It was also missing from
  **Working**, where every other stage with that status appears.

  The gate in that case is *ahead* of the frontier: `nextAction` returns the first
  unresolved stage, so a stage being `active` means the route is working and will reach
  the gate on its own. Nothing is being asked of anybody yet. Third time this trade has
  been got wrong one branch at a time — `externalGate` and the verification branch each
  had to learn that `active` is neither yours nor theirs.

- **A check declared after a stage first ran never reached a correction**
  (`refreshCheckDeclarations`). `verify`, `planFile`, `planOutput` and
  `requiresPullRequest` are not instructions given to a run — they are the tests the
  stage's *next* output has to pass — but only `refreshPendingStages` carried them, and
  it excludes any stage that has started. A stage re-opened by a correction keeps its
  finished subtasks by design, so it was always judged by whatever config said the day
  it first ran.

  Found on a live task: `rc-plan` gained `planOutput` on 26 August and the task's stage
  ran on 24 August, so correcting it would have re-run the planning stage and settled
  with **no open-questions check** — the exact failure `planOutput` exists to prevent, on
  the one stage where the operator had just said every question must surface. A resolved
  stage is still left alone, and so is one sitting at a gate with nothing left to run.

## 0.115.1

- **A gate declared after a task started reached nothing.** `requiresApproval` is derived
  from a route's `gate` when the pipeline is created, and no refresh pass carried it — so
  declaring a gate, or `authority: "evidence"` which is inert without one, changed only
  tasks created afterwards. Found on a live task that had correctly picked up
  `authority: "evidence"` and kept `requiresApproval: false`: the declaration parsed,
  refreshed, and could never fire. The silent no-op an unquoted hook command already
  taught this codebase to fear.

  One-directional, and the asymmetry is deliberate. A gate **added** in config now reaches
  a task in flight; one **removed** does not. Adding a stop to work somebody is part-way
  through supervising is safe, where silently dropping a checkpoint from every running
  task is the assurance-removal this whole area is built to refuse.

## 0.115.0

Adaptive execution: the route can now continue, repair itself and re-run a stale stage
without an operator driving it. **Nothing changes until a route opts in** — all four new
declarations are absent everywhere, and absence is exactly the previous behaviour.

Measured first, on 17 live pipelines: of 320 approvals only 49 were on a stage that
could carry a real authority boundary, only 16 carried any note at all, and 205 of 353
discard entries ($394 of $570) were the operator re-running a stage by hand.

- **`authority: "evidence"`** on an approval gate lets the harness pass it when the
  evidence is clean — no blocking findings, a declared check that ran and exited 0,
  nothing held, nothing declined and unsettled. It goes through the same `approveStage`
  a person does, so the checklist, operator actions and plan-step accounting are all
  still enforced. Never permitted on a `humanVerification` or `assessment` stage, where
  approving does more than let the route continue.
- **`autoRepair`** on a review lets it name the stage that should fix what it found, as
  `REPAIR: <stage> — <what>`. The reviewer proposes and the harness rules: legality
  comes entirely from the existing `sendBackTo` declaration, the target must be earlier
  and must have produced something, and the repair is the existing `correctStage`, so
  invalidation is unchanged.
- **`mayMutateRoute`** lets a stage propose two route changes. `REVERIFY: <stage> — <what
  changed>` re-runs an earlier stage whose output went stale — recorded as an amendment,
  because the stage was right when it ran. `INSERT-STAGE: <kind> | <name> | <objective>`
  adds work nothing owns; its position is derived, it is always gated, and it can never
  be a human gate or an assessment.
- Both mutations are surfaced: an inserted stage names the stage that asked for it in
  the tree and the report, and a re-run reads as "re-run after X found its output
  stale" rather than borrowing the amendment's "was corrected".
- The protocol went into the harness skill; only the markers are contract.

## 0.107.0

- **A stage completed, was held for approval, and left no trace on disk.** `save` re-read
  the state file immediately before mutating, on the stated grounds that two callers
  touching different tasks could not then clobber each other. The read is what made that
  false: it is a multi-megabyte `await`, so two concurrent saves both take a snapshot,
  both mutate their own copy, and the later rename silently discards the earlier one.

  Measured on a live promotion. The stage pushed its branch, deployed to UAT, wrote a
  full report and was held on its pull request — and none of it persisted, because a
  busier task saved in the same window. The failure then inverts: the file kept saying
  the stage was `active`, so every advance for the next 25 minutes refused with "already
  running", and a window reload rebuilt the same state from the same file. A stage that
  had finished successfully was unreachable by every route the UI offers.

  Mutations now queue behind one another, per repository.

- **Stop killed the session and left the record saying it was running.** The reclaim went
  through the stale sweep, whose two guards describe exactly the subtask a stop is aimed
  at: ownership skips one *this* host started, and the age threshold waits an hour. So a
  stop of this host's own session did nothing that outlived the process — and stop is
  what people reach for when a task looks wedged, which makes it the one command that
  must leave the record consistent.

- **A lock the state file never had.** The mutation queue serialises one extension host.
  The file is shared by every worktree of a repository and by a headless run, so a second
  process interleaves its read-modify-write the same way. An exclusive-create lock now
  guards each mutation — fail open throughout, because a lock that cannot be taken must
  never stop a write.

- **Nothing appeared until every git call returned.** A cold render awaited live git state
  for every task before drawing a row: two processes each, ~400ms on nine tasks, on every
  activation and reload. The first render of a window now draws from the state file alone
  and fills git in after. Later renders are unchanged, because a refresh must never show
  a row computed before the change that triggered it.

## 0.90.0

- **The withdrawal fallback left the route with no legal move.** A correction filed before
  0.88.0 has no snapshot of how its stage stood, so the stage cannot be handed back its
  old verdict — nothing recorded it, and inventing one is the single thing an undo must
  not do. It was therefore left `pending` for the operator to approve again.

  `pending` was a dead end. The stage's own subtasks are all `done`, so `nextAction` reads
  an unresolved stage with nothing left to run as `blocked` — a state its own comment
  calls impossible, because `finishSubtask` had been the only thing that could ever
  produce it — and `approveStage` then refuses the stage for not awaiting approval. The
  fallback whose entire purpose was "the operator approves it again" offered nothing that
  could approve.

  It is now `awaiting-approval`: honest, since nothing here certified the work, and
  resolvable, since that is the one status the operator can act on. What made this sharp
  rather than theoretical is the narrowing — the fallback is reachable *only* by
  corrections that predate 0.88.0, so the only runs that could hit it were the only runs
  it exists for.

  The withdrawal dialog now says the stage comes back awaiting approval, and repeats that
  **the harness never reverts files**: a correction that edited the worktree leaves those
  edits on disk, and re-opened stages re-run against whatever the worktree currently holds
  rather than undoing anything.

## 0.88.0

- **A correction can now be withdrawn.** `correctStage` had no inverse, and a finding is
  not always right — a comment acted on before it was investigated, or one raised by
  somebody reading the report rather than the code. Until now the only ways back were
  editing the state file by hand or re-running the stage from cold, which is the
  demolition corrections were built to avoid, reached from the other side. So the cheapest
  response to a *wrong* finding was to leave it standing.

  What made it more than deleting a subtask is that filing a correction destroys the
  stage's own conclusion — its status, `verdict`, `verification` and any `BLOCKED:` reason
  — because all of it was about the version being corrected. That is right while the
  correction stands and unrecoverable once it does not: none of it is re-derivable, since
  a verdict is what a reviewing session said and the session is gone. `correctStage` now
  snapshots that settlement onto the correction subtask, and **Withdraw the Last
  Correction…** puts it back exactly.

  **Withdrawing re-opens the stages after it, exactly as filing does**, and that rule is
  now written once and shared by both. It did not start that way, and the gap is worth
  recording because it is invisible in the direction that matters: correct a plan, let the
  stages after it apply the corrected plan, then withdraw the correction, and those stages
  are left recorded as passed against a plan that no longer exists. Filing re-opens them
  because they ran against output that just changed; withdrawing changes that output in
  precisely the same way, and re-opening stages that filing had *already* re-opened and
  which have since re-run is the whole point rather than an edge case. What those runs
  cost is booked as collateral, and what they declined is settled with them.

  What does *not* come back is stated in the dialog rather than left to be assumed, since
  a partial undo believed to be total is worse than none. **The harness never reverts
  files** — not here, not in `revertToStage`, not in `correctStage`; git is the source of
  truth for changed paths, and always was. So a correction that edited the worktree leaves
  those edits on disk after it is withdrawn, and a plan stage is the sharpest case,
  because `planFile` is read fresh from the worktree on every run. Re-opened stages do not
  revert anything; they re-run against whatever the worktree currently holds. The dialog
  says so. The withdrawn correction's own cost moves to the discarded ledger rather than
  vanishing with it, because what a route cost is what was spent on it.

  Three narrowings, each load-bearing: only the **most recent** correction, because
  corrections stack and each snapshotted what the one before it had already cleared, so
  unwinding out of order would restore a conclusion a standing correction had invalidated;
  never while one is **running**, since the session is still writing; and a correction
  filed **before this shipped** has no snapshot, so its stage is left for the operator to
  approve again rather than handed a verdict invented at withdrawal time. Guessing a
  verdict is the one thing an undo must not do. (The status that fallback used was itself
  wrong — see 0.90.0.)

## 0.86.2

- **Approving a gate no longer fails with "operation not permitted".** The state file is
  written by write-then-rename because the rename is atomic, which is what stops a
  concurrent reader ever seeing a half-written blob. Atomic is not the same as always
  permitted: Windows refuses to replace a file while anything else holds it open, and on
  a git dir that is routine — Defender reads it moments after it is written, the indexer
  opens it, and the extension and a headless run write it by design. Every one of those
  clears in milliseconds.

  It surfaced at the worst possible point. The write happens *after* the in-memory
  transition, so approving a gate advanced the route, reported `EPERM … likely caused by
  the extension`, and left the advance unpersisted — an approval that looked done, was
  done on screen, and would not have survived a window reload. The rename now retries with
  a short backoff, and only on codes that mean "someone else has it open"; `ENOENT` and a
  real permissions failure still fail on the first attempt, because retrying a genuine
  misconfiguration turns it into unexplained slowness.

## 0.86.1

- **Approve came back to the stage awaiting approval.** Its menu entry matched the row by
  equality — `viewItem == stage-awaiting-approval` — which was right until corrections
  shipped and `stagePresentation` began appending a second token to any stage holding
  output to correct. A stage awaiting approval has by definition just run, so it is always
  correctable, so the context value is always `stage-awaiting-approval correctable` and the
  equality never held again. The one row the button exists for was the one row that could
  not show it, while Correct and Send Back stayed visible because their clauses match by
  substring. A test now fails any `viewItem == stage-…` clause: stage context values are
  space-joined by design, so equality is never the right test for one.

## 0.57.0

- **A stage that executes a written plan must now account for every numbered step.** The
  fifth instance of the harness's one recurring failure, and the most expensive: a
  deployment stage shipped a migration, a flag and the procedures, silently did not do
  step 4 of its plan — a post-deploy data rebuild — and **passed**. It surfaced in
  production as a scorecard tile reading 0.0%, found by hand.

  Nothing already here could catch it. `verify` would need a post-condition query written
  per ticket. `DEFERRED` catches work a stage *declines*, and this stage declined nothing;
  it simply did not do it and said nothing. The stage self-reported one outcome for the
  whole document, so a skipped step was indistinguishable from a completed one.

  A stage with `planFile` set is now given the plan's numbered steps and must answer for
  each — `STEP 4: done — …` or `STEP 4: not done — …`. **Step identity comes from the
  file**, because the plan is written by one cold session and executed by another, so
  nothing held in a session can identify a step. A step reported not done is a correct
  answer and becomes a deferral, holding the next stage that ships until someone owns it.
  A step nobody mentions holds the stage itself: `approveStage` refuses it, so silence
  cannot pass. A stage whose plan file is missing is not run at all, since improvising
  from the brief is the state this exists to make impossible.

- **`verify` commands can name the task they are certifying.** `${taskName}`, `${branch}`,
  `${baseBranch}` and `${worktreePath}` are substituted before the command runs. Without
  them a check written once for a route could not tell which ticket it was running for, so
  a script meant to reject a worktree parked on *another* ticket's promotion degraded into
  an existence check — one that passes in exactly the case that matters. Anything else in
  `${...}` reaches the shell as written, because that is real syntax in both shells and
  corrupting working commands to catch typos is the wrong trade. The **substituted** form
  is what the failure reason and the stage's activity report, since the declared form
  would send a reader to run something different by hand.

- **The worktrees a stage creates are now recorded, and tidied up.** Stages make worktrees
  the extension never made — a `promote/<ticket>-uat` tree, a publish tree — so nothing
  cleaned them up and nothing could tell that two tasks were promoting through the same
  one. Nine accumulated in a week, two holding a commit that had never reached DEV: the
  directories were the visible symptom, the stranded commits the actual loss.

  Claims are **detected, not requested**: the worktree list is compared before and after a
  stage the route lets move the tree, so anything that appeared was created by this task
  and anything already there was borrowed. That distinction is what makes cleanup safe —
  a created `promote/*` tree may be removed, while the standing `qube-publish-*` trees
  must be left where they were found or the next publish has nowhere to run. A worktree
  another task holds now **holds the stage** instead of being noticed by an agent reading
  `git worktree list` and mentioned in prose. On completion the task offers to remove only
  what it created, clean, and fully merged — and never deletes a branch, which may hold
  the only copy of its commits.

- **Fixed: reloading the window switched the holds off.** `normalizePipeline` runs on every
  read of the state file and rebuilt each stage field by field, so every field added since
  it was written — `verify`, `verdict`, `blocked`, `mayChangeBranch` — plus the whole
  `deferrals` list was silently dropped. A route held on deferred work resumed as though
  there were none.

- **Verify All** is now on the task row rather than only in its right-click menu
  (`inline@2`, matching the denial action). The command had been correct since 0.54.0 and
  invisible.

## 0.56.0

- **A route fix now reaches tasks already in flight.** `addMissingStages` adds stages a
  route gained since a task was created, positioned by route order, run at the top of
  every advance. Correcting a route that was missing a step previously left every
  in-flight task without it, and the only remedies were to do the step by hand or throw
  the task away — the same argument that already justifies refreshing a pending stage's
  intent.

  Safe by two rules. A stage is inserted only **ahead of the frontier** — after
  everything that has started, passed, failed, been skipped or is awaiting approval —
  because inserting behind one would let a route claim to have run a step it never ran.
  A stage that belongs behind the frontier is reported as too late and named in the log,
  rather than dropped silently or forced in. And nothing is ever removed: a stage the
  route no longer defines may already have run, and the pipeline is the record of what
  happened.

- **A held stage now says why, permanently.** The `BLOCKED:` reason lived only in a step
  line and a log entry, so reopening the window left a stage awaiting approval with no
  account of what was missing. It is persisted on the stage and shown in the report —
  the same lesson `verdict` already learned, when a blocking review came to look like a
  clean one.

- **`routeComparison` compares two sets of route runs on cost and on outcome.** The
  numbers were all being recorded per subtask; what was missing was a way to read them
  together to answer whether carrying a stage's conclusion forward costs less than
  letting the next stage rediscover it.

  It leads on **fresh input tokens** rather than a total, because `cacheRead` is nearly
  free and a total would hide the effect being measured. And it **refuses to name a
  winner** when it cannot honestly do so: fewer than two runs an arm, any subtask that
  reported no usage, or an arm that failed, was held, or left deferrals outstanding —
  since spending less by doing less is not a saving. The deltas are still reported when
  the verdict is withheld.

## 0.55.0

- **A step only a human can take now stops the route until it is done.** A stage may
  end a line with `ACTION: <what to do>`, URL verbatim, one per step. Each is recorded
  against the stage that named it, the route holds there, and the stage cannot be
  approved while any remain outstanding.

  The fourth instance of one failure mode. A promote stage prints a pull-request link
  that must be opened; a publish stage names a registration in a third party's console
  that is in no cherry-pick. Routes already asked for these — "say for each whether it
  was done or still needs a human with console access" — and the answer arrived as prose
  in a reply nothing parsed, so the step was skipped and the promotion was quietly
  incomplete. `producesChecklist` allowed only `behaviourReview` and `humanVerification`
  to raise an item, so a deployment stage had nowhere to put one.

  It holds at the stage that raised it rather than at the next human gate, because
  several routes have no gate between a promote and what follows, and a pull request
  nobody merged makes the next stage wrong. **"Verify All" deliberately skips these**:
  ticking a verification in bulk is a judgement about risk, and ticking "I opened the
  pull request" in bulk is simply untrue. The tree says "for you to DO" rather than "for
  you to verify", since those invite different behaviour. `ChecklistItem.kind` is
  optional and absent means `"verify"`, so existing items keep their meaning with no
  migration.

- **`readStageReply` owns the order the markers come off in.** Six markers — NEEDS-INFO,
  VERDICT, HANDOFF, DEFERRED, BLOCKED, ACTION — were read and stripped by six adjacent
  statements, with the ordering between them expressed only as comments: the verdict must
  come off before the handoff split, and deferrals, refusals and actions must be read
  from the report half only, or a handoff *describing* a decline is counted as a second
  one. That order is now one pure function with a test per rule.

## 0.54.0

Quality pass over the three features added in 0.51–0.53. Two of these are visible.

- **A held stage's report no longer has a gap where the marker was.** `stripBlocked`
  removed the `BLOCKED:` line without the newline collapse that `stripVerdict` and
  `stripDeferrals` both carry. The marker normally has prose after it, so the removal
  left a triple newline — which renders as a section break in the one report a human
  opens *because* the route was held.

- **A refused merge now names the files in the way.** `MergeOutcome.blocked` was
  already collecting the paths git reported and then showing only "commit or stash
  them first", which left the reader to go and find out which files it meant.

- **One definition of "outstanding checklist item", not three.** The task row counted
  them one way, the stage row another — the first excluded skipped stages and the
  second did not — while the command that ticks them used the engine's
  `outstandingChecklist`. Both rows now call the engine too. The tree decides whether
  "Verify All" is offered and the command decides what it acts on, so a disagreement
  meant the button could appear with nothing to tick, or an outstanding gate with no
  button.

- **`resolveTask` is shared rather than copied.** The merge command had its own
  byte-for-byte duplicate, so the next accepted argument shape would have been added to
  one and silently not the other — and an unresolved task means the command returns
  having done nothing, which is indistinguishable from its legitimate no-ops.

- **`firstBlocker` now matches its own comment** and does the free in-memory checks
  before the git call, instead of spawning git twice to discover that a session was
  running. Plus a dead `HEAD` filter in the branch parser that its only caller can
  never produce, and a doc comment that had ended up above the wrong function.

## 0.53.0

- **A stage that says it did not do its work no longer passes.** A stage may end its
  reply with `BLOCKED: <what is missing>`; the route then holds that stage for a human
  instead of recording it as done.

  This closes the oldest and most expensive form of the self-report gap. A deployment
  stage had exactly two ways to fail — the session erroring, or a declared `verify`
  command exiting non-zero — so a stage with no `verify` whose agent *correctly
  refused* was recorded as `finishSubtask(..., "done")`. Observed in full: a task
  reached its live verification gate with twelve stages passed, having never committed
  a line. The agent that stopped it had explained precisely why, in prose, and nothing
  read prose. Even `VERDICT: block` would not have helped — the verdict is parsed on
  every reply but only acted on for `codeReview` and `domainReview`.

  Deliberately one-directional: there is no marker meaning "I succeeded". A stage that
  does work has no verdict to give on itself, and asking one to declare itself clear
  would be the self-certification the harness exists to remove. Reporting a refusal is
  not a claim of success, so only the refusal is asked for. Reviews keep `VERDICT` and
  are not offered `BLOCKED`, since two overlapping protocols means the model picks one
  and which one is a coin toss.

  Held rather than failed, like a blocking review: the stage did the right thing by
  refusing, and what is wanted is a human deciding about the missing prerequisite, not
  a red mark against the agent that spotted it. The marker is stripped from the reply
  the report shows, and the reasoning around it kept.

## 0.52.0

- **Every outstanding checklist item can be verified at once.** "Verify All Checklist
  Items…" on a task's context menu, shown only while something is actually outstanding.
  For the supervisor case the harness is now aimed at — several tasks in flight, the
  same handful of boxes on each — ticking them one at a time was friction with no
  corresponding safety.

  It asks for one sentence describing what was done, and records that against every
  item it ticks. That is the whole design: the human-verification gate's only value is
  that somebody confirmed each behaviour, and a bulk tick is the obvious way to make
  the gate ceremonial. An item ticked in bulk and one ticked after actually exercising
  the behaviour would otherwise be indistinguishable in the report — which is the only
  lasting evidence the gate meant anything. Cancelling the note cancels the tick.

  A note written before the tick is kept and the bulk note appended, since the earlier
  one is the more specific. An already-verified item is left entirely alone, notes and
  timestamp included: a bulk tick must never overwrite the record of an individual
  verification. Scoped to the task rather than a stage, because the gate is blocked by
  every outstanding item whichever stage raised it.

## 0.51.0

- **A task can take in a branch it was cut before.** "Merge Branch Into Task…" on the
  task's context menu, offering the task's base branch first and any other local
  branch below it. A worktree is a checkout of its base branch *as that branch was
  when the task was created*, so tooling committed to the base afterwards is simply
  absent — which surfaced as a stage failing its `verify` command because the script
  did not exist. From the symptom that is indistinguishable from a check that ran and
  found something, so the fix was invisible.

  Most of the feature is what it declines to do. It refuses over uncommitted changes,
  because `--abort` restores the merge and not work that was never committed; while an
  agent session is running or a stage is active, because files moving under a live
  session leave it editing a tree it no longer has; and when the worktree's branch has
  drifted from the task's `intendedBranch`, since that worktree is on a branch nobody
  asked about and merging into it compounds the problem rather than revealing it.

  Conflicts are aborted rather than left in place, and the conflicting paths reported.
  A worktree mid-merge has markers in its files and unmerged entries in its index, and
  both feed the changed paths the rules engine reads — so a stalled merge would get to
  decide which reviews a task owes. A merge and not a rebase, because a rebase
  rewrites the commits a stage report already cites. Either way the review plan is
  unaffected: changed paths diff `baseBranch...HEAD`, against the merge base, so
  taking the base in does not add the base's own changes to the task's diff.

## 0.47.0

- **The branch guard offers a button rather than a command to type.** When a route
  stops because the worktree is on another branch, the notification now carries
  **Check Out "<branch>"**, which returns the worktree and advances. Also on the task's
  context menu and in the palette as "Check Out This Task's Branch", since the
  notification is dismissable and the stop is not.

  Plain `git checkout` — no force, no stash. Git refuses when the switch would discard
  local changes, and that refusal is the useful answer: the reason the worktree is
  being moved back is that something is in the wrong place, and overwriting work
  silently would be a worse version of that problem. Git's own stderr is shown,
  because it names exactly which files are in the way.

## 0.46.0

- **A stage's outcome can come from a process instead of the agent's word for it.** A
  route stage may declare `verify`, a command run in the worktree once its last
  subtask succeeds; a non-zero exit fails the stage whatever the agent reported. This
  closes the harness's oldest correctness gap: `finishSubtask(..., "done")` recorded
  that a session ended without error, not that the build compiled or the object
  deployed — and everything above it, gates and handoffs and reviews holding a route,
  rested on an agent's account of its own work. Observed in one afternoon: the same
  review reporting `block` and then `pass` on identical evidence.

  A command that cannot *start* is reported differently from one that fails: nothing
  verified the work either way, so the stage still fails, but the message says to fix
  the command rather than the work. The command and its output are recorded with the
  stage's activity and shown in the report, redacted — a stage that failed
  verification is exactly the one whose output is wanted. Read from the repository
  root like the rest of the harness config, never from a worktree, so a branch cannot
  choose the command that certifies it.

- **"Show What This Did" leads with what the agent reported.** The reply was last,
  under the tool counts, the file lists, the commands and their output — so reading a
  finished stage's conclusion meant scrolling past everything that produced it. Order
  is now findings, the reply, checklist, guidance, intent, and the mechanics last —
  collapsed once the stage has settled, left open while it is running or if it failed,
  which are the two times those details are the point.

## 0.45.0

- **Rules ask before appending more than a couple of reviews.** Rule-added stages are
  the only ones nobody chose: you pick a route, and the engine then appends agent
  sessions to it off a derived path set. Above two in one go it now asks, listing each
  review with the rule's reason, how many paths matched and an example — and the
  changed-path count, since that is the number that explains a surprising set. Four
  unrelated reviews ran on a one-line change with nobody having agreed to any of them.

  One or two does not ask: a SQL change obliging a SQL review is the design working,
  and interrupting for it would train the reflex of clicking through, which is what
  makes the fifth one dangerous. Escape counts as declining, because the expensive
  reading of a dismissed dialog must not be "go ahead". A declined set is suppressed
  for the session and offered again next time — never persisted, since a permanently
  suppressed review is what the harness exists to prevent. Headless runs, having
  nobody to ask, behave exactly as before.

## 0.44.0

- **The rules engine states its inputs, not just its verdict.** It reported "added 5
  required reviews", which reads as the rules doing their job; that it had been handed
  9,569 changed paths — the thing that made every rule match — appeared nowhere. Each
  evaluation now logs the rule count, the path count, the branch diffed from and the
  base, and every match names the paths that triggered it. A review appended for a
  reason nobody can see is one nobody can judge.
- **An implausible changed-path set is not acted on.** The set is derived from three
  git commands against a base branch, so it can be wrong in ways that look like a very
  large change rather than an error — a stale base, a rebase, a squashed merge, a
  `baseBranch` that was never right. Above 750 paths the engine declines to apply
  rules and says which base branch to check, in the log and in the run report. The
  branch guard in 0.43.1 catches the cause we found; this catches the shape whatever
  the cause, because the next one will not be the one already fixed.

  Deliberately dumb, and erring high: a missed review is worse than a slow one, so it
  only fires on the obviously absurd. A few hundred files is a big refactor; several
  thousand is not a change at all.

## 0.43.1

- **Review rules are not evaluated while the worktree is on another branch.** The
  changed-file set is computed against the task's base branch, so once a promotion
  stage moved the worktree the diff was between two whole lineages rather than the
  task's work: 9,569 changed paths instead of a handful, on a real task that had
  touched one stored procedure. Every rule in the project's file matched, and an ETL
  review, a resource-string culture review, a tenant-config review and a tooling
  Pester run were all queued onto a small SQL change. The rules engine now sits out
  while the branch is wrong and says so, rather than acting on a diff that describes
  something else.

## 0.43.0

- **A task's branch is now tracked, so moving the worktree breaks rather than
  redefines it.** Git is the source of truth for which branch a worktree is on, and
  reconciliation therefore adopted whatever it found — so a stage that ran
  `git checkout` silently made that branch the task's branch. Nothing was
  inconsistent afterwards, so nothing could be detected: a migration-and-rollback
  review found no migration scripts on the branch it had moved to and reported that
  absence truthfully, about a tree nobody had asked about. `intendedBranch` is
  recorded once and never refreshed (backfilled from the recorded name, not from
  git, so a task already sitting on a switched branch is not enshrined), and a stage
  will not start a session — split or run — while the worktree is elsewhere.
- **`mayChangeBranch` marks the stages where moving is the work.** A UAT promotion
  goes through a PR and a live publish runs out of the standing publish worktrees, so
  a blanket prohibition would have broken exactly the stages that need it. Such a
  stage is told it may move the worktree and asked to return it, and stages after it
  refuse to run until it is back.
- **A review spliced in behind a deployment that already ran says so.** There is
  nowhere earlier to put it — a pending stage cannot be placed before one that has
  run — so the placement looked routine while the review had lost the ability to
  prevent anything. It now reports which deployments it could not get in front of,
  and suggests declaring the stage in the route rather than leaving it to a rule.

## 0.42.0

- **An approval gate says what it found and what to do about it.** It previously said
  only that a stage was waiting, so a review that blocked on a wrong stored procedure
  and one that passed cleanly arrived looking identical — deciding meant reading the
  whole reply to work out which. The notification now leads with the finding summary
  and the recommended action, and offers that action as the first button: **Send
  Findings Back…** when the stage has somewhere to send them, **Approve** when
  nothing is blocking. A verification gate with unticked items offers neither, since
  approving over outstanding evidence is what the gate exists to prevent. The same
  block appears at the top of Show What This Did.

  Where a stage has no `sendBackTo` configured, it says so and names the key, rather
  than recommending a button that is not there.

- **The verdict marker no longer leaks into what you read.** `VERDICT: block` is a
  protocol line between the harness and the agent, and nothing stripped it — so it
  reached the report, the handoff and every later stage's prompt verbatim. It is now
  removed once parsed and recorded on the stage instead, which also fixes the case
  behind it: a review that stated `block` but whose findings did not parse left a
  stage held for approval with nothing on screen explaining why.

  An inferred conclusion is labelled as inferred. A stated verdict and one read out
  of prose warrant different confidence — the inference has now been wrong in both
  directions.

## 0.41.1

- **A finding stated in its own heading is no longer lost.** The most natural way to
  write a review is one line per problem with the severity in front of it —
  `### Critical: the change is against the wrong stored procedure`. That is 55
  characters, so it failed the 40-character label cap that stops a sentence merely
  containing "critical" from reclassifying everything after it, and the generic
  heading rule then cleared the severity. A review with a blocking finding and an
  important one parsed to nothing and displayed as clean. The cap now applies to the
  label, not to the summary after it.

  A bare `CRITICAL: …` line still reports only itself: a severity heading takes the
  bullets below it, and treating an unmarked line as a heading is how one blocker was
  counted as fourteen.

## 0.41.0

- **A session that fails before running anything leaves its reason behind.** The
  CLI's error arrives as an item belonging to no tool call, and the activity watcher
  only kept output from command tools — so it was discarded, the subtask recorded no
  tools, no commands and no reply, and `isEmpty()` reported nothing worth persisting.
  The report was then blank and read as though the stage had never started, which is
  precisely the case where the reason is the only thing there is to see. Session-level
  errors are now captured (redacted, capped, deduplicated) and shown under **Session
  errors**, and the CLI's message is emitted as an item rather than only when stderr
  happened to be non-empty.
- **A failed session is no longer described as one with nothing recorded.** "No
  activity was recorded for this subtask" invites the reader to go looking for what it
  did; a stage that died on startup gets told plainly that there is nothing to find.

## 0.40.3

- **A failure now leaves a trail, not one line.** 0.40.2 fixed the reason string but
  not where it went: the CLI's stderr was logged at `debug`, which the output channel
  discards unless someone has set the level to Debug, and an errored result was never
  logged at all. So one info line was the entire record. An errored turn now logs at
  error level with the subtype, the CLI's message and its stderr (redacted), and every
  failing path through the stage runner logs the reason, the session id and how far it
  got — because "died having run no tools" and "died after forty" read identically
  from a reason alone.
- **Show What This Did leads with the failure.** The reason sat halfway down, below
  the tool counts, reading as a footnote to a successful run. It is now the first
  thing under the header, and the CLI's machine-readable subtypes are explained:
  `error_max_turns` says the stage ran out of turns and should be narrowed or split,
  rather than leaving the reader to find that out.

## 0.40.2

- **A failed stage says what actually went wrong.** The reason was the fixed string
  "the agent reported an error", while the CLI's own account — a turn limit, a rate
  limit, a spawn failure — sat in a transcript item nobody persisted. The stage row,
  the report and the log now carry the CLI's words, its subtype (e.g.
  `error_max_turns`) or its stderr, in that order.

## 0.40.1

- **An existing task picks up stage handoffs without being recreated.** `handoff`
  is snapshotted onto a stage at creation, so a task created before the field
  existed would never carry anything forward. The next advance now brings the flags
  in line with config and backfills the conclusion of any stage that has already
  passed, from the reply already in the state file.

## 0.40.0

- **A review states its verdict rather than having one inferred.** Review stages end
  with `VERDICT: pass` or `VERDICT: block`, and that is what holds the route.
  Parsed severities remain what the row and report display, and are the fallback for
  a review that stated nothing. A route-stopping decision should not rest on a prose
  heuristic: the previous inference read a report containing one blocker and a long
  "everything else is fine" section as fourteen blockers, because only a *severity*
  heading cleared the section context. Any heading now clears it.

## 0.39.0

- **A review that finds something stops the route.** A stage outcome was purely
  self-reported — "the session ended without error" — so a review reporting critical
  findings passed exactly like a clean one and the route carried on to deploy. A
  code or domain review with a blocking finding is now held for approval. Held
  rather than failed: the stage did its job, it found problems.

## 0.38.0

- **Stages carry their conclusions forward.** A stage marked `handoff` in the route
  hands what it concluded to every later stage, presented as established and not to
  be re-derived. Capped, and opt-in per stage, because a fresh session per subtask is
  what makes a review independent — re-deriving what the last stage established is
  not part of that bargain.
- **The prompt prefix is cacheable.** The preamble led with the task name, so every
  stage prompt differed from the first character and nothing was reusable across the
  dozen sessions a route spawns. Invariant text now leads.
- **Each session logs fresh versus cached input tokens and cost**, so a route's cost
  is attributable rather than a single total.

## 0.37.1

- **Credential masking judges a variable name by its segments.** `$env:QSQL_PW` was
  missed because the rule required the name to *begin* with a secret word. Segments
  are compared whole, so `PW` matches in `QSQL_PW` while `PATH` and `COMPASS` do not.

## 0.37.0

- **A stage is told its earlier output may already exist.** A stage is the unit of
  re-run, so a cold session reading "write the migration and a paired rollback"
  rewrote four correct files when the actual defect was a missing folder.

## 0.36.0

- **The stage order repairs itself on an existing task.** Reviews spliced after a
  deployment by an earlier build are moved back in front of it on the next advance.
  Only stages that have not run move.

## 0.35.0

- **Reviews run before anything is deployed.** Rule stages were spliced before the
  first human gate, which in a route that deploys to dev before signing off put a
  SQL review *after* the deploy. The barrier is now the first stage that ships work
  or hands it to a person.
- **Tasks are grouped by what they need** — Needs you, Working, Parked, Done, No
  route — because a task can sit at a verification gate for days.
- **Recorded paths and output are no longer truncated for display.** Tool details
  were capped at 120 characters and output at 500, both flattened to one line, so a
  report inherited a chat row's truncation. Full-fidelity copies are kept, and an
  over-long block keeps its tail as well as its head.

## 0.34.0

- **Credentials are masked in everything the harness records.** Commands are kept
  verbatim and both they and their output are written to the task state file, so a
  route building a connection string put a live password on disk and in a report.
  Masked at capture and again at render, including single-letter flags like
  `sqlcmd -P` on lines naming a tool known to take one.

## 0.33.0

- **`planning` is a stage kind.** A planning stage matched `kind:implementation`, so
  "back to whoever wrote this" silently included "plan the whole thing again".

## 0.32.0

- **`deployment` is a stage kind.** A deployment declared as implementation was the
  nearest match for a review sending work back, so the obvious way back from a
  failed review was to run the deployment again.

## 0.31.0

- **A review can send its findings back to an earlier stage.** Previously the only
  route back discarded the reviewing stage's reply — the act of sending work back
  destroyed the reason for it. Findings travel as guidance, which survives. Opt-in
  per stage via `sendBackTo`, naming stage ids or `kind:<StageKind>`; only earlier
  stages resolve, so no entry can create a loop.
- **Review findings are surfaced in their own right**, with severities read out of
  the reply: a stage row now reads `passed · 1 critical, 2 important`.

## 0.30.1

- **The routeless task is named for what it gives you** — "Chat task" rather than
  "No route", under its own heading, with the routes above it labelled as the
  project's or the built-ins.

## 0.30.0

- **`stageMcpServers` applies to task chat sessions too.** A chat resolved the
  project config whole and passed no strict flag, so it started every server plus
  the worktree's own and every user-scope one.

## 0.29.1

- **A dead extension host's held calls and unanswered questions are discarded.**
  Both inboxes are cleared when a run ends, but a host killed mid-stage never gets
  there — so the next run swept up a dead CLI's question and attached it to whichever
  subtask was running by then.

## 0.29.0

- **"Show what it did" is read-only, rendered, and live.** It was an editable
  untitled document holding a snapshot, so closing it asked to save text nobody
  wrote and it never updated. A running stage's work now appears as it happens.
- **The diff is a file list with per-file comparison.** The before side reads at the
  branch point, and a rename reads at its old path.

## 0.28.0

- **A checklist is no longer invisible from both ends.** The stage holding the items
  was a green row saying nothing about them, and the gate they block raised none of
  its own so showed no count. Clicking an item now ticks it.

## 0.24.0

- **A stage now shows when it is waiting rather than working.** Any `active`
  stage rendered with the same spinner, so one sitting on seven unanswered
  questions was indistinguishable from one busily running — "has it moved on or is
  it stuck?" had no answer on screen. A stage blocked on questions or ungranted
  refusals now shows a waiting icon and says what it is waiting for.
- **The task row names the stage in play.** It previously reported "implementing"
  while the *planning* stage was still running, because the label came from git
  heuristics — dirty files and commits ahead — which know nothing about the route.
  A harnessed task now reads e.g. `Plan…`, or `Plan — waiting — 2 questions`.
- **Granted rules survive the task.** A file refusal suggested a rule naming the
  worktree it happened in, which is dead as soon as that task is finished. Both
  forms are now written: the absolute rule, which is the one known to match, and a
  worktree-relative twin that outlives it.

  Command rules are deliberately left absolute. They are matched against the
  literal command text, and the agent writes absolute paths because its working
  directory is the worktree — which is why a hand-written
  `PowerShell(tools\jira\x.ps1:*)` never fires and needs its absolute twin.

## 0.23.1

- **Fixed: `stageMcpServers` reduced the config but every server still started.**
  `--mcp-config` *adds* servers rather than replacing them, and a task worktree
  contains the project's own tracked `.mcp.json` — approved there by the copied
  `.claude/settings.local.json`. So the reduced copy was loaded *alongside* the
  full set and a stage asked for one server still started nine, at the same three
  minutes. `--strict-mcp-config` is now passed whenever the set has been narrowed
  on purpose, and only then, since it also discards user-scope servers.
- **Fixed: a refusal could be attributed to the wrong tool.** Observed as
  "Read denied — This Bash command contains multiple operations", which cannot
  happen: results were paired with the most recent tool call, and the agent had
  issued its calls in parallel. Worse than a wrong label — the refusal taught the
  permission gate about the wrong capability, so it held retries of a tool that
  was never refused and let the real one be denied again, with no prompt. Results
  are now matched to their call by `tool_use` id, falling back to the previous
  rule only when a stream carries no ids.
- **Fixed: a refusal outside `gatedTools` was reported nowhere.** 0.22.0 stopped
  notifying on a first refusal because the gate would hold the retry — true only
  for tools the gate is installed for. Combined with the misattribution above, a
  refusal could vanish entirely. The notification is now suppressed only when the
  feature is on, the hook really installed, **and** the gate covers that tool.

## 0.23.0

- **Added `taskWorkspaces.stageMcpServers`**, so a stage session loads only the
  MCP servers a route actually needs. The startup logging added in 0.22.2 turned
  up the reason stages felt hung: nine servers in a project's config, eight of
  them local `stdio` processes that failed, and **182 seconds of sequential
  connect timeouts — paid again on every subtask of every stage**. A build stage
  does not need seven database servers to compile something. Empty (the default)
  means all of them, so nothing changes until it is set. A name matching no
  server is treated as a mistake and the project's config is used unchanged,
  because a typo must not silently strip every tool. The reduced copy is written
  to extension storage, never into a worktree where it would land in the changed
  paths the review rules key off — and since filtering only ever *removes*
  servers, it cannot widen what a task branch can reach.

  Worth knowing if your servers bind fixed ports: subtask-per-session means every
  subtask starts its own copy, so two stage sessions can never hold the same port,
  and sequential ones can still collide while the previous set shuts down.

## 0.22.3

- **Fixed: "7 questions" with no way to answer them.** The count appeared on the
  task row, but the only route back to the panel was an inline action VS Code
  reveals *on hover* — so the problem was plainly visible and the remedy was not,
  and the panel that opened when the questions were first asked was gone once
  closed. Questions now appear as **rows nested under the stage that asked them**,
  the way refusals already did, and clicking one opens the panel. Answered
  questions show their answer in the tooltip.
- **Fixed: a stage whose only children were questions was a leaf.** Exactly the
  bug 0.19.3 fixed for refusals, one release later for questions: the row could
  not be expanded, so nesting the questions under it would not have helped. The
  rule that decides a stage's expansion moved into the pure presentation module
  where it is unit-tested against all three kinds of child — it had been sitting
  in a file no test can reach, which is why the same mistake shipped twice.

## 0.22.2

- **Startup latency is now attributable.** Three minutes could pass between
  "Permission gate active" and "Session model", with nothing logged in between,
  which reads as the extension having stalled — and invites blaming the gate or
  the model, neither of which is responsible. The model line now reports how long
  the CLI took to become ready, and the MCP servers it started are listed with
  their statuses. Servers that failed to connect are called out, because they
  cost their full connection attempt on **every subtask** and are the first thing
  worth removing from a project's MCP config.

## 0.22.1

- **Fixed: git probes reported their answers as errors.**
  `show-ref --verify --quiet` exits 1 to say a branch does not exist, and
  `rev-parse --is-inside-work-tree` fails to say a folder is not a repository.
  Both were logged at error level, so creating a task printed
  `git show-ref … failed` for a check that had worked perfectly, and every
  non-git workspace folder printed one too. Nothing was broken by it — the
  callers read the exit code correctly — but a red line in the log for a
  question correctly answered sends people hunting a fault that never happened.
  Such runs are now logged at debug; the result they return is unchanged.

## 0.22.0

- **Fixed: a held tool call was announced to nobody, so a stage looked hung.**
  Holding a call is the only moment the agent is genuinely blocked on a person,
  and it produced a tree row and a log line — nothing else. Meanwhile the *first*
  refusal did raise a notification, offering "Add Rule", which cannot release a
  call the hook is already holding. So the useless prompt arrived first and the
  useful one was invisible: the stage sat there until the CLI's hook timeout
  expired, or until the run was stopped by hand. A hold now raises the
  notification, with **Allow**, **Allow for Session** and **Deny** wired to the
  waiting hook, so the agent continues mid-turn. Dismissing it loses nothing —
  the row offers the same decisions. The first-refusal notification is suppressed
  only when the gate is actually installed, so a gate that failed to arm still
  reports.
- **Task state moved out of extension storage into the repository**, at
  `<git dir>/task-workspaces/state.json`. Extension state made this extension the
  only thing that could read a task list. Under the git directory rather than the
  working tree for two reasons: review rules key off git's changed paths, so state
  in a worktree could oblige a review by being written, and every linked worktree
  shares the main repo's git dir, so one store serves them all. The old global
  copy is adopted once per repository and then kept as a backup, so nothing is
  lost and a misfire is recoverable.
- **Settings and logging no longer require an editor.** Defaults and
  normalisation moved into a `vscode`-free module, and the `Logger` interface was
  split from its output-channel implementation — sharing a file meant all 26
  modules that log were coupled to VS Code by importing the interface. A guard
  test now walks the import graph from every module a headless run must construct
  and fails with the offending chain if one reaches `vscode`.

## 0.19.3

- **Fixed: a stage with refusals but no checklist could not be expanded**, so the
  rows that grant them were unreachable — clicking Reveal appeared to do nothing.
  Refusals now count towards a stage's expansion and expand it by default.
- **Fixed: rules suggested the shell instead of the command.** Taking the first
  token of a compound command produced `Bash(cd:*)`, `Bash(bash:*)` and
  `PowerShell(powershell:*)` — the first grants nothing meaningful and the others
  grant everything the interpreter can be told to run, which is the same
  objection as excluding `powershell.exe` from a virus scanner. Shells,
  interpreters and builtins are now skipped: `cd X && ./run.sh` suggests
  `./run.sh`, `powershell -File x.ps1` suggests `x.ps1`, and when every
  candidate is a wrapper **no rule is offered** — that call needs a human
  decision, not a blanket grant. The validator's own "the following part requires
  approval" fragment is preferred over the whole command when present.

## 0.19.2

- **Fixed: suggested allow rules were noise for file tools.** A refused `Write`
  produced `Write(C:	emp
mgb2792q.ps1:*)` — the `:*` prefix form belongs to
  shell commands, and a rule naming one scratch file under a ticket-specific
  folder is replaced by a new dead entry every ticket. Rules are now tool-aware:
  command tools keep `Tool(executable:*)`, file tools get a **directory glob**,
  and a path under a temp root generalises to that root — so many scratch files
  collapse into one `Write(C:/temp/**)` instead of one rule each.
- **Added "Allow All Refused Commands"** on a task with outstanding refusals.
  Retrying is not free: the subtask re-runs in a fresh session from the start, so
  approving one rule and advancing, then the next and advancing again, pays for
  the stage twice. Granting them together costs one re-run. The task row now
  shows "2 to approve".

## 0.19.1

- **Refusals are a row in the sidebar, not a toast.** They are persisted on the
  stage that hit them and appear nested under it with an inline **✓ Allow This
  Command** action — the same shape as verification items. Approving writes the
  rule, marks the row allowed, and offers to advance; the row survives a
  dismissed notification and a window reload, which a toast did not. An **✕**
  ignores a refusal the stage can manage without.

  The notification is now just a pointer with a **Reveal** action, since nothing
  is lost by closing it.

## 0.19.0

- **A refused tool call now stops the route and offers to grant the permission.**
  Previously the refusal was reported after the whole advance had finished, by
  which point the minutes were already spent.

  A refusal is detected the instant it appears in the stream, so the warning
  arrives while the stage is still running, naming the tool and command. The
  route then pauses with the subtask left **pending**, and the notification
  offers **Add Rule & Retry** — which writes a prefix rule into the project's
  `.claude/settings.local.json`, copies the file into the worktree, and advances
  again — or **Add Rule**, or **Continue Without**.

  There is deliberately no "Approve once". Verified against the CLI (2.1.220):
  a stream-json session emits no permission request of any kind — not in
  `manual` mode either — so there is nothing to answer while a call waits. There
  is no `--permission-prompt-tool` and `canUseTool` is an Agent SDK callback,
  and adopting the SDK would cost the subscription auth, `.claude/` config and
  MCP setup that driving the CLI preserves. Adding the rule and re-running the
  subtask is the nearest equivalent, and cheap because every subtask is a fresh
  session anyway.

  New `taskWorkspaces.pauseOnPermissionDenial` (default true) turns the pause off
  while still reporting. The settings file is edited defensively: unknown keys
  are preserved, existing rules are never removed, and unparseable or
  wrongly-shaped content is refused rather than overwritten — it is a file the
  user hand-edits and the CLI reads.

## 0.18.1

- **Denied tool calls now reach the user.** A headless stage session has nobody
  to approve anything, so any call not covered by `permissions.allow` is refused —
  and the refusal was invisible. The agent rewords the command, retries, then
  works around it or asks a question that reads like a briefing problem. One
  observed case burned 39 seconds and five turns retrying a single script five
  different ways, every planning stage, with nothing anywhere naming the cause.

  Refusals are now detected, collapsed per call with an attempt count, logged in
  full, and reported after an advance — including when the stage *succeeded*,
  since a refusal rarely fails a stage and would otherwise never surface. The
  notification offers **Copy Allow Rules**, which yields prefix rules
  (`PowerShell(path/to/script.ps1:*)`) ready to paste into `permissions.allow`.
  Prefix rather than exact, because the arguments change every run; the
  PowerShell call operator is stripped, since `&` is itself what trips the
  "multiple operations" check.

  Deliberately narrow: an operating-system `Permission denied` on a file is a
  real error, not a policy decision, and is not reported as one.

## 0.18.0

- **Questions are persisted, itemised, and answered in a proper panel.** A stage
  that needs information used to raise a modal with every question crammed into
  one detail field, followed by a single-line input box. That failed three ways:
  dismissing it **lost the questions** — and the session that asked them was
  gone, so the only way back was re-running the stage; one answer field for five
  questions meant one reply addressing whichever the user happened to read; and
  nothing on screen said which task was asking.

  Now the runner stores the questions on the pipeline before any UI appears.
  Each is a separate item with its own answer field in a webview panel titled
  with the task name, answers save as you type, and the task row shows
  "2 questions" with an **Answer Questions** action until they are dealt with.
  Submitting appends each `Q:`/`A:` pair to the brief.

  Prompts now ask for a numbered list, one question per line, and the parser
  splits bulleted or numbered replies into separate items — an unlisted paragraph
  stays whole rather than being split at every newline. Records that stored a
  single question string still load.

## 0.17.0

- **A route stage can name its own model.** Add `"model": "sonnet"` to a stage in
  `harness.json` (or to a rule's stage) and that stage's sessions — including the
  planning session that splits it — run on that model. Stages without one keep
  using `taskWorkspaces.model`.

  This is the dial that matters once per-process overhead is dealt with. On a
  measured planning stage, tool calls fell from a 9.6s median to 0.37s and the
  time waiting on tools from 61% of the stage to 20% — leaving **80% of the wall
  clock as model time**, 115 turns of it. No further infrastructure work touches
  that number; the model does.

  The point is to be selective rather than uniformly cheaper. Deciding which of
  three directories a script belongs in is reading and comparing. Writing the
  migration that will run against a live database is not, and should stay on the
  stronger model.

## 0.16.4

- **Stages now read and maintain the project's own documentation.** New
  `taskWorkspaces.projectDocsPath` (default `docs/`) is named to every stage,
  which is told to read what is relevant there *before* exploring the code, and
  to add or update a document when the work establishes durable knowledge — a
  business rule it had to work out, a data flow, a structural decision and its
  reason.

  This is the harness's only lasting memory. Subtask-per-session bounds context
  by making every stage start cold, and the cost of that is rediscovery: each
  session re-derives what the last one worked out and discards it on exit. A
  document in the repository is the one place a finding survives, so reading it
  is cheaper than re-deriving and writing it back is what stops the next stage
  paying the same price.

  Bounded deliberately: stages are told not to record progress notes, change
  summaries, or anything the code already states plainly, and to correct a
  document they find out of date. Set the path to empty to disable — a project
  with no documentation convention should not be told to invent one mid-task.

## 0.16.3

- **Creating and removing a task now report progress in the status bar.** Removal
  had no indication at all while it archived transcripts, stopped the agent and
  shelled out to `git worktree remove`, so a slow removal was indistinguishable
  from a click that had not registered. Creation only covered the git call —
  copying local config into the worktree and attaching the route happened after
  the progress had closed. Each step now names itself.
- **Fixed: removing a task did not stop its route.** Only the session was
  stopped, which the driver reads as a finished turn and answers by starting the
  next subtask — against a worktree about to be deleted.
- Confirmation prompts now sit between progress items rather than underneath
  one, so the unmerged-branch warning is not shown behind a spinner.

## 0.16.2

- **Fixed: MCP servers were silently missing in every task worktree.** A worktree
  is a directory the CLI has never seen, so a project-scoped `.mcp.json` in it is
  unapproved — `enabledMcpjsonServers` stays empty and none of its servers start.
  Non-interactive sessions skip the trust *dialog*, which is not the same as
  granting trust, and a route's headless sessions have nobody to answer a prompt.
  Sessions now pass the config explicitly via `--mcp-config`, so a planning stage
  can reach the ticket tracker and database servers its prompts assume. New
  `taskWorkspaces.mcpConfigPath` (default `.mcp.json`), resolved from the
  **repository root** — MCP servers grant tool access, so a branch must not be
  able to hand itself new capabilities. `--strict-mcp-config` is deliberately not
  used, so user-scope servers are unaffected.
- **Fixed: path arguments were unquoted when the CLI is spawned through a shell.**
  `--add-dir` has always been passed a real path, and on Windows the process is
  spawned with `shell: true`, so a repository under a path containing a space was
  silently truncated at the space. Argument building moved to a pure, tested
  module (`claudeCliArgs.ts`) rather than being inferred from a running process.

## 0.16.1

- **Fixed: "Stop Agent" now stops the route, not just the session.** Killing the
  session ended the current subtask, which the driver read as "that turn
  finished" and answered by starting the next one — so the agent stopped and the
  route carried on, and a second Advance Route could end up driving the same task
  alongside the first. Stop Agent now cancels the route first, discards the
  interrupted reply, and reverts that subtask to pending, so Advance Route
  resumes from where it stopped instead of skipping past it.
- **Fixed: a task left mid-subtask by a closed window is no longer stuck.**
  `startSubtask` persists "running" before the session starts, but sessions die
  with the extension host, so the flag outlived the work and every later Advance
  Route answered "a subtask is already in flight" — permanently, with no way
  back. A running subtask the current runner never started is now reclaimed. A
  genuinely concurrent advance is still refused.
- **The per-subtask timeout is configurable and no longer destroys the work.** It
  was a hard-coded 15 minutes, and a stage that hit it was recorded as failed
  with its reply discarded — so a planning stage that had spent 15 minutes
  investigating left nothing behind, not even a diagnosis. New
  `taskWorkspaces.stageTimeoutMinutes` (default 45), and whatever the stage
  produced before the cap is kept.
- **Route progress moved to the status bar.** A route runs for many minutes and
  several tasks can run at once, so one dismissable toast per task buried the
  notifications that actually needed an answer. The sidebar already shows the
  stage and subtask; only outcomes needing a human now raise a notification.
- **Fixed: the context size was read from the wrong place, so every turn
  compacted.** A `result` event's `usage` is cumulative over the whole run, like
  `total_cost_usd` — not the size of the current context. Reading it reported
  3.8M tokens for a session whose real peak was 133k, so the auto-compaction
  threshold tripped at the end of every turn. Context is now taken only from a
  message's own usage.
- **Fixed: stage sessions no longer auto-compact.** Compaction is applied when a
  turn settles, and a subtask is a single turn, so the only compaction it could
  ever run is one on a session the runner has already finished with. Every
  subtask was paying for a summary of a context nobody would read again.
- `ClaudeStageSessionRunner` now depends on a narrow `StageSessions` interface
  and is covered by tests, including the timeout and post-settle paths.

## 0.16.0

- **Engineering harness.** A task can now be given a **route** — a declared
  sequence of stages the work must travel through — chosen when the task is
  created. "Advance Route" drives it: a planning agent splits splittable stages
  into subtasks, each subtask runs in its own fresh Claude session, and the run
  stops at the first human gate or failure. Stages and their verification items
  appear nested under the task in the sidebar.
- **Per-project routes.** Routes live in the same config as rules, so the stages a
  kind of work travels through are the project's decision — a .NET line-of-business
  app and a TypeScript library do not share a workflow. A project's routes replace
  the built-ins entirely; define none and the three built-ins are offered so the
  picker works on day one. Every route must contain a stage with
  `"gate": "approval"`, or it is rejected — a route that could pass itself would
  defeat the harness.
- **Per-project review rules.** `.taskworkspaces/harness.json` in the
  repository root holds `{ routes, rules }`; `rules` map changed file paths to the reviews they oblige — SQL review,
  behaviour review, compatibility review. Rules are re-evaluated as the diff grows
  and matched reviews are inserted before the human gate. The extension ships
  **no** rules of its own: a project with no rules file requires none. Starter
  sets are copied in by "Create Review Rules File". Rules are read from the
  repository root, never a task worktree, so a branch cannot relax the reviews it
  is subject to.
- **Behaviour review with a human checklist.** Behaviour-review stages ask the
  agent to act as a QA planner rather than a judge: its output is a checklist of
  things a person must exercise, and the terminal human-verification gate refuses
  to pass while any item is unchecked. "Show Required Reviews" reports what a
  task's real diff obliges, and works on unharnessed tasks as advice.
- **Checkpoint instead of compact.** New `taskWorkspaces.contextStrategy`. Set it
  to `checkpoint` and a session crossing the auto-compact threshold writes a
  size-capped handoff, then continues in a fresh session briefed from it, instead
  of summarising in place. The handoff and the brief sent are both logged.
- **Copy local config into new worktrees.** New
  `taskWorkspaces.copyIntoWorktree`, for untracked files a fresh worktree lacks —
  `.claude/settings.local.json` being the obvious one. Destinations that escape
  the worktree are refused; a missing source is skipped, not fatal.
- **Fixed: a schema mismatch used to discard every stored task.** The task
  repository returned an empty list on any `schemaVersion` it did not recognise,
  including one written by a *newer* build. Because worktrees with no matching
  task are reported as orphans, that turned a populated task list into a list of
  unadopted strangers, losing every task's name, description and base branch.
  Stored state is now migrated, unreadable entries are quarantined rather than
  dropped, and unknown fields are preserved.

## 0.15.0

- **Fixed the conversation replaying its opening messages partway through.**
  Resuming a session re-appends its earlier entries to the same transcript —
  verbatim, keeping their original `uuid` and timestamp — so replaying the file
  as written showed the first message and the replies after it a second time. One
  real 555-entry transcript contained 196 such repeats; across the transcripts on
  this machine it was roughly doubling the replayed conversation. Entries are now
  de-duplicated by `uuid`, keeping the first occurrence.
- Messages that genuinely repeat still show twice: identical text is not treated
  as a repeat, only an identical entry id.

## 0.14.1

- Log what a replay recovered from disk (item count, and the last item) when a
  chat resumes. Missing history is otherwise unattributable: because the CLI
  writes a reply only once the turn completes, "it was on screen and vanished on
  reload" and "it never reached the transcript" look identical from the UI.
  Check the Task Workspaces output channel next time it happens.

## 0.14.0

- **Untracked worktrees can now be removed without adopting them first.**
  Orphan rows previously offered only "Adopt", so deleting one meant creating a
  task purely in order to destroy it. There is now a trash button on the row and
  a "Remove Untracked Worktree" context-menu entry, with the same confirmations
  as the tracked Remove: it warns about uncommitted changes, offers to delete the
  branch too, and offers a forced delete if that branch has unmerged commits.

## 0.13.0

- **Fixed chat history going missing after a window reload.** Replayed
  conversations were capped at the most recent 300 items — a real 3,600-entry
  session produces 2,040, so roughly 85% of it silently vanished, including most
  user turns. Longer sessions lost more, which is why it looked intermittent. The
  cap is now 4,000 items and the transcript read allows 24 MB rather than 2 MB.
- **Truncation is no longer silent.** If either cap does bite, the replay starts
  with a note saying how many earlier messages are not shown, instead of leaving
  a gap that looks like data loss.
- The read is asynchronous now, so raising the caps doesn't reintroduce the
  freeze fixed in 0.10.1 — a multi-MB transcript no longer blocks the extension
  host while it loads.

## 0.12.1

- **Plan usage now actually refreshes on its own.** It only re-probed when the
  view became visible or when you clicked `refresh`, so leaving the sidebar open
  left it frozen — including the relative reset labels, which are rendered
  server-side and so stayed on whatever they said when the view was built. The
  visible view now ticks every minute, and the snapshot is treated as stale
  after 2 minutes rather than 5.
- The tick only runs while the view is visible, and re-renders only when the
  content actually changed — writing the webview HTML reloads it, which would
  otherwise collapse any Drivers window you had expanded and flicker once a
  minute.

## 0.12.0

- **Added a "Drivers" section beneath plan usage**, showing what the CLI
  attributes your usage to — per window (Last 24h, Last 7d) with its request and
  session counts, the behaviours it flags (`53% >150k context`,
  `51% sessions active for 8+ hours`), and the ranked Top skills / subagents /
  plugins / MCP servers. The most recent window is expanded; older ones collapse.
- Named "Drivers" rather than "Split" or "Breakdown" on purpose. The CLI states
  these are *"independent characteristics, not a breakdown"*, and they routinely
  total over 100% — one request can be long-context *and* subagent-heavy *and*
  running in parallel. They are shown as plain percentages, not bars, for the
  same reason, with a note saying so.
- Parsing skips anything it can't read rather than guessing, so a wording change
  upstream shows less instead of showing something wrong.

## 0.11.0

- **Added an "Open in Visual Studio" button**, shown in the details view only
  when the worktree actually contains a solution or project — it stays out of
  the way on a Node or Python task. The solution it will open is named beneath
  the buttons, annotated `.NET Framework` or `.NET`.
- Detection reads the file listing git already provides, then classifies the
  target framework from the project files: old-style
  `<TargetFrameworkVersion>v4.x</TargetFrameworkVersion>` and SDK-style
  `<TargetFramework>net48</TargetFramework>` are both .NET Framework, `net8.0`
  and `netcoreapp*` are modern, and multi-targeting counts as Framework if any
  target is. Results are cached per worktree.
- Visual Studio is located with `vswhere`, requiring `devenv.exe` specifically.
  `vswhere -latest -products *` is not trustworthy: other products build on the
  Visual Studio shell and are listed alongside it — on this machine SQL Server
  Management Studio 22 was returned as "latest", ahead of Visual Studio, so a
  solution would have opened in SSMS. If no install is found you're offered the
  shell's default association instead.
- **Added a "File Explorer" button** to every task, which reveals the worktree
  in the OS file manager. Also available from the task's context menu, along
  with Open in Visual Studio.

## 0.10.1

- **Fixed the chat panel hanging on open.** Replaying a prior conversation read
  the entire transcript synchronously — and transcripts reach tens of MB (9.3 MB
  locally), so the whole window froze while it parsed. Only the last 300 entries
  are ever shown, so it now reads just the tail (capped at 2 MB), discarding the
  leading partial line.
- **Opening now reports what it is doing** in the status bar — *checking for a
  running session…*, *loading conversation history…* — instead of looking
  ignored until the panel appears.
- The session scan and the file/slash-command scan now run concurrently rather
  than one after the other, and the `claude agents --json` timeout is 5s rather
  than 10s: it is advisory, so failing fast and starting beats a long stall.

## 0.10.0

- **Plan usage is now its own sidebar view**, alongside Task Workspaces and
  Details, rather than a section inside Details. Usage is account-wide, so it
  shouldn't appear and disappear with the tree selection. It re-probes whenever
  the view becomes visible.
- **Removed the session cost chip** from the chat header. On a subscription the
  dollar figure is notional — you aren't billed per token — so it sat next to
  the real limits implying a cost that isn't charged.
- **The `/compact` summary no longer replays as a giant user message.** Compact
  injects its summary as an ordinary `user` transcript entry flagged
  `isCompactSummary` but *not* `isMeta`, so reopening a compacted session
  rendered the whole summary as something you had typed. It is suppressed, and
  the compaction boundary now shows as a divider instead — `Context compacted —
  474k → 15k tokens`.
- **Typing `/compact` now behaves like the Compact button.** Only the button set
  the internal flag, so a typed `/compact` produced no marker and left the
  context chip on its stale pre-compact number.

## 0.9.1

- **Fixed usage bars always rendering full.** The fill width was set via a
  `style="width:N%"` attribute, but the view's CSP specifies `style-src` without
  `'unsafe-inline'`, so inline style attributes were dropped entirely — an unset
  width falls back to `auto`, i.e. a full bar, so every window looked maxed out.
  Dynamic widths now come from a nonce'd `<style>` block, and `.usage-fill`
  defaults to zero width so a missing rule can never read as 100% again. The
  same bug silently discarded the phase colour on `<body>`; that is fixed too.
- **Reset times are now relative**, matching the Claude extension's style —
  `resets in 2 days`, `in 7 hrs`, `in 45 mins` — instead of an absolute
  `Jul 30, 2pm (Europe/London)`. The original text is kept as the tooltip. If a
  reset clause can't be parsed it is shown verbatim rather than guessed at.

## 0.9.0

- **Plan usage percentages now show in the Details view**, below the task
  details, with a progress bar per limit window (session, weekly, per-model),
  its reset time, and a manual `refresh`. Bars turn amber past 75% and red past
  90%. Also shown when no task is selected, since usage is account-wide.
- Figures come from the CLI's `/usage`, run in a **throwaway session** so it
  never appears in your chat transcript. `/usage` is answered locally — the
  reply is a `<synthetic>` model with zero input and output tokens — so this
  costs no tokens, only a process spawn. Results are cached for 5 minutes and
  re-probed when the view is shown.
- The output is human-readable text with no machine-readable equivalent, so
  parsing is deliberately tolerant: if the format changes, the section reports
  "Usage unavailable" rather than showing something wrong, and the live chips
  added in 0.8.0 keep working.

## 0.8.0

- **Plan usage is now always visible in the chat panel and updates live.** The
  CLI pushes a `rate_limit_event` unprompted on the normal stream, so the header
  shows the current window (e.g. `5h`), a `resets in 2h 15m` countdown that
  ticks on its own, and an overage flag — with no polling, no extra turns and no
  cost. Anything other than `allowed`, or an active overage, is highlighted.
- **Session cost is shown** alongside it, read from `total_cost_usd` on the
  turn's result event.
- **Reordered the task buttons** so Chat comes before the Claude-extension
  button.
- **Removed the duplicate "Open Workspace" button** from the task row and
  context menu — the Claude-extension button already opens the worktree in a new
  window. The command itself is retained (the create flow and the details view
  still call it) and remains available from the Command Palette.

## 0.7.0

- **Sessions are now discovered from `claude agents --json` (query → reuse →
  create).** Opening a chat first asks the CLI what is actually live. If this
  window already owns a session for the task it is reused as before; if a
  session we don't own is running in that worktree — left over from a previous
  window, a terminal-mode session, or one you started yourself — you are offered
  the choice to continue it or start a separate one, instead of silently running
  two agents in the same directory.
- **Discovered sessions are never terminated automatically.** Your own
  interactive Claude sessions legitimately run in these directories, so the
  extension only ever offers to adopt or to start alongside.
- Worktree matching is exact and done client-side rather than via the CLI's
  `--cwd` flag, which matches descendants recursively; a repo-root query would
  otherwise sweep in sessions from every worktree nested beneath it. Matching is
  case-insensitive and separator-agnostic because the CLI reports drive letters
  inconsistently (`c:\` and `C:\` both appear in a single listing).

## 0.6.0

- **Added a "New" button to the chat panel — start a fresh session.** Every
  existing path resumed the same Claude session id, so a wedged session was
  sticky and deleting the worktree was the only escape. "New" abandons the
  conversation and starts a session with an empty transcript (no `--resume`, no
  carried-over messages). Confirms first; the old session stays open-able under
  History.

## 0.5.2

- **Show the model a session is actually running on.** The panel header now
  displays the model reported by the CLI's `system`/`init` event (e.g.
  `opus-5[1m]`), so the running model is visible rather than inferred from the
  dropdown. See *Known issues* below for why this matters.

## 0.5.1

- Style the model dropdown to match the permission-mode dropdown — it was
  rendering as an unstyled browser default. Added hover and focus states, and
  both dropdowns are now disabled in read-only history view.

## 0.5.0

- **Model switcher labels no longer hardcode versions.** 0.4.9 labelled the
  options with version numbers and asserted Opus topped out at 4.8 — wrong, and
  stale as soon as Opus 5 shipped. The values were always family *aliases* that
  resolve to the latest model in each family, so the labels are version-agnostic
  again.
- The `taskWorkspaces.model` setting now accepts an explicit model id (e.g.
  `claude-opus-5`) instead of being restricted to a fixed list.

## 0.4.8

- **Added a model switcher to the chat panel.** A Model dropdown
  (Default / Fable / Opus / Sonnet / Haiku) maps to the CLI's `--model`.
  Switching restarts the session on the chosen model via the existing resume
  path and persists the choice via the new `taskWorkspaces.model` setting.

## 0.4.7

- **Added `taskWorkspaces.autoCompactThreshold`.** When a session's context
  exceeds this many tokens, `/compact` is issued automatically at the end of the
  current turn. Defaults to `0` (off). Recommended to set it above
  `compactPromptThreshold` so you are warned first — e.g. `160000`.
- **Fixed the context chip after `/compact`.** It kept showing the stale
  pre-compact number until the next turn, so compaction looked like it had not
  happened. The chip now shows a "compacted" placeholder immediately and the
  next turn's usage repopulates the real size.

## 0.4.6

- **Made the large-context warning harder to miss.** The compact prompt was a
  faint 14% tint; it is now a warning-coloured bar with an icon, accent border
  and a prominent Compact button, plus a brief pulse when it appears. The
  context chip also pulses once over threshold.

## 0.4.5

- **Fixed the permanent "Session ended with an error" loop.** Recovery passed a
  session id whose transcript had never been written (the first turn errored
  before any save), so every `--resume` failed with *No conversation found* and
  the chat could never recover. Both resume paths now check the transcript
  exists and otherwise start a fresh session, carrying the in-memory transcript
  forward.

## 0.4.4

- **Surface the real cause of an errored turn.** Error results often arrive with
  empty result text, so the panel only showed a generic message. It now falls
  back to the result subtype and captures a tail of the CLI's stderr, rendered
  as a collapsible detail.

## 0.4.3

- **Resume after an errored turn, not just a dead process.** An error `result`
  marks the turn complete, so the session sat in `waiting` with the CLI alive
  but unresponsive; the next message was written into the stuck process and
  silently ignored.

## 0.4.2

- **Resume ended chat sessions on send instead of dropping the message.** A
  failed or stopped session left its child process dead, so `send()` silently
  no-opped and the composer looked broken. Sending now transparently resumes.

---

## Known issues

- **"Default" model selection is non-deterministic on resumed sessions.** With
  Default selected no `--model` is passed, and resuming without one does not
  reliably inherit the current default: a resumed session reported plain
  `claude-opus-5` where a fresh one got `claude-opus-5[1m]`, and a resumed
  `haiku` session came back as `claude-sonnet-5`. **Choose an explicit family
  (e.g. Opus) if you need a predictable model.** The header chip added in 0.5.2
  shows which model a session is actually on.
- **Auto-compact has not been exercised in a live session.** The setting
  defaults to `0` (off). Treat it as untested when enabling it.
- **The underlying cause of `error_during_execution` on a first turn is not
  diagnosed.** 0.4.2–0.4.5 fix the *recovery* from it (you can always continue
  the chat), not the trigger. If you hit it, the stderr detail added in 0.4.4
  should show the cause — please share it.
