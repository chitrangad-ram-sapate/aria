# Governance

How the ARIA repository is owned, protected and opened up to the team. This implements decision **D-022** in `decision.md`.

## Current state

| Who | GitHub handle | Access | Owns |
|---|---|---|---|
| Repository owner (master control) | `chitrangad-ram-sapate` | Owner | **A**: optimizer & explanations (`mob-apk/engine/aria/engine/`) |
| Collaborator | `ruturajnalbalwar-arch` | Write | **B**: data & forecasting (`mob-apk/engine/aria/forecast/`, `mob-apk/engine/data/`) |
| Collaborator | `thevipulbangar` | Write | **C**: baselines, verifier & replay (`verify/`, `metrics.py`, `baseline_a.py`, replay results) |
| Collaborator | `Physics0070` | Write | **D**: mobile app, validation, `.svcr`, Firebase, demo (`mob-apk/src`, `android`, `ios`) |

## How each owner contributes

Every owner commits from their **own machine and GitHub login**, so each commit carries its real author:

```bash
git clone https://github.com/chitrangad-ram-sapate/aria.git && cd aria
git switch -c owner/<a|b|c|d>-<topic> origin/dev      # e.g. owner/b-forecast-import
# ...edit files in your area...
git add -A && git commit -m "<what changed>"
git push -u origin HEAD
gh pr create --base dev --fill                         # CODEOWNERS requests the right reviewers
```

Flow: owner branch → PR into `dev` (reviewed by the area's code owner) → `dev` → PR into `main` (one approval, green CI).

- The repository is **private**.
- A personal-account repository cannot give collaborators an admin role. Only the owner can change settings, protection rules or visibility.
- `.github/CODEOWNERS` maps each area to its owner, and maps the shared contract (`schemas.py`) and docs to the whole team.

## Moving to a GitHub organization

Organizations can only be created on the GitHub website, not through the API or the CLI.

### 1. Create the organization

1. Signed in as `chitrangad-ram-sapate`, open <https://github.com/account/organizations/new> (or profile picture → **Your organizations** → **New organization**).
2. Pick the **Free** plan, enter an organization name and contact email, and choose "My personal account" as the owner.
3. Skip inviting members on the last step. Teams are set up below.

### 2. Transfer the repository

1. Open `chitrangad-ram-sapate/aria` → **Settings** → **General** → **Danger Zone** → **Transfer**.
2. Choose the new organization as the destination, type the repository name to confirm, and transfer.
3. GitHub redirects the old URL. Each member should still update their remote:
   `git remote set-url origin https://github.com/<org>/aria.git`

Issues, pull requests, stars and existing collaborator access move with the repository.

### 3. Members and teams

1. **Organization → People → Invite member**: invite `ruturajnalbalwar-arch`, `thevipulbangar` and `Physics0070`. Make them **Owner** only if they should be able to manage the whole organization; otherwise **Member**.
2. **Organization → Teams → New team**:
   - `maintainers`: add `chitrangad-ram-sapate` and any member who should manage settings. Then on the repository: **Settings → Collaborators and teams → Add teams** → `maintainers` → **Admin**.
   - `contributors`: add all four members. Repository role **Write**.
3. Set **Organization → Settings → Member privileges → Base permissions** to **No permission**, so access comes only from the teams.
4. Optional: replace the handles in `.github/CODEOWNERS` with `@<org>/maintainers` and `@<org>/contributors`.

### 4. Protect `main`

On the repository: **Settings → Branches → Add branch ruleset** (or **Add classic branch protection rule**) for `main`:

- Require a pull request before merging.
- Require **1** approving review. Also tick "Require review from Code Owners".
- Dismiss stale approvals when new commits are pushed.
- Require status checks to pass: select the **CI / test** job from `.github/workflows/ci.yml`. It appears after CI has run once.
- Require branches to be up to date before merging.
- Block force pushes and deletions.
- Leave "Do not allow bypassing" off, so `maintainers` can merge in an emergency during the demo.

On a free personal account, branch protection on **private** repositories is not available. That is one more reason to move to an organization (free organizations have the same limit; GitHub Team or a public repository removes it). Until then, the team agrees to merge only through reviewed pull requests with green CI.

## Members linking their own organizations

ARIA stays in one home organization. Members who also want it under their own organization use one of these:

- **Fork**: fork `<org>/aria` into their own organization and open pull requests back to `main`. For a private repository, the home organization must allow forking (**Organization → Settings → Member privileges → Repository forking**).
- **Outside collaborator**: someone from another organization who is not a member is added on the repository as an outside collaborator with a specific role (**Settings → Collaborators and teams → Add people**).
- **Team sync per organization**: if a whole partner organization needs access, invite its people as members and put them in a team with the right role. Do not grant base permissions.

## Rules for every change

- Work on a branch, open a pull request to `main`, use the PR template.
- CI (`pytest -q`) must be green.
- Any change to a decision goes into `decision.md` as a new entry; old entries are marked superseded, never deleted.
