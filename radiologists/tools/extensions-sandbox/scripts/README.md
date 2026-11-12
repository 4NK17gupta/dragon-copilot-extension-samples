# Extensions Sandbox setup scripts

These scripts set up the [Extensions Sandbox](../README.md) and start it in one step. They check that
the tools it needs are installed, get the source code, install the dependencies and open the sandbox
in your browser.

| Script | Use it on |
| --- | --- |
| `setup-extensions-sandbox.ps1` | Windows (Windows PowerShell 5.1 or PowerShell 7) |
| `setup-extensions-sandbox.sh` | macOS, Linux and WSL (bash) |

## What the script does

1. Checks that Git is installed and that Node.js and npm are recent enough. On Windows, it can install
   them for you (see `-InstallPrerequisites` below).
2. Gets the source code:
   - **Run from a copy of the repository you already have** (a clone, or a ZIP you downloaded and
     extracted), it uses that copy as it is. Nothing is downloaded, and your branch and files aren't
     changed.
   - **Run on its own** (for example, after downloading just the script), it clones the `Partner`
     branch of <https://github.com/4NK17gupta/dragon-copilot-extension-samples> into a
     `dragon-copilot-extension-samples` folder in your home folder. On later runs, it updates that
     clone to the latest commit.
3. Installs the sandbox's dependencies with `npm ci`. The first time, this takes several minutes.
   On later runs, it's skipped unless the dependencies or your Node.js version changed.
4. Starts the sandbox and opens <http://localhost:3000> in your browser.

## Before you start

You need:

- **Node.js** `^20.19.0` or `>=22.12.0`, with **npm 9** or later. The current LTS version from
  <https://nodejs.org> works.
- **Git**, from <https://git-scm.com/downloads>. You don't need Git if you run the script from a copy
  of the repository you already have.
- Access to `github.com` and the npm registry (`registry.npmjs.org`). If you're behind a proxy, see
  [Troubleshooting](#troubleshooting).
- Ports 3000 and 4000 free on your machine.
- About 1 GB of free disk space.

On Windows, the script can install Git and Node.js for you with winget: add `-InstallPrerequisites`
to the command. npm 9 or later comes with supported Node.js versions.

## Option 1: Download the script and let it get everything

Use this if you don't have the repository yet.

### Windows

Open **PowerShell** (from the Start menu) and run:

```powershell
cd $HOME
Invoke-WebRequest -UseBasicParsing -OutFile setup-extensions-sandbox.ps1 -Uri https://raw.githubusercontent.com/4NK17gupta/dragon-copilot-extension-samples/Partner/radiologists/tools/extensions-sandbox/scripts/setup-extensions-sandbox.ps1
powershell -ExecutionPolicy Bypass -File .\setup-extensions-sandbox.ps1
```

To have the script install missing Git or Node.js with winget, run the last line with
`-InstallPrerequisites` at the end:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-extensions-sandbox.ps1 -InstallPrerequisites
```

`-ExecutionPolicy Bypass` lets this one run of the script start even if your PowerShell settings block
downloaded scripts. It doesn't change your settings.

### macOS, Linux and WSL

Open a terminal and run:

```bash
cd ~
curl -fsSLO https://raw.githubusercontent.com/4NK17gupta/dragon-copilot-extension-samples/Partner/radiologists/tools/extensions-sandbox/scripts/setup-extensions-sandbox.sh
bash setup-extensions-sandbox.sh
```

### Where the code goes

The repository is cloned into `dragon-copilot-extension-samples` in your home folder (for example,
`C:\Users\<you>\dragon-copilot-extension-samples` or `~/dragon-copilot-extension-samples`). To use
another folder, add `-InstallDir <folder>` (Windows) or `--dir <folder>` (macOS, Linux and WSL), and
use the same option every time you run the script.

## Option 2: Run it from a copy of the repository you already have

Use this if you've cloned the repository, or downloaded it from GitHub as a ZIP (**Code** >
**Download ZIP**) and extracted it.

### Windows

```powershell
cd <repository folder>\radiologists\tools\extensions-sandbox
powershell -ExecutionPolicy Bypass -File .\scripts\setup-extensions-sandbox.ps1
```

### macOS, Linux and WSL

```bash
cd <repository folder>/radiologists/tools/extensions-sandbox
bash scripts/setup-extensions-sandbox.sh
```

The script uses this copy as it is and doesn't run any Git commands that change it. To get the latest
code, run `git pull` yourself (or download and extract a new ZIP), then run the script again.

If you add `-InstallDir`, `-Branch` or `-RepoUrl` (`--dir`, `--branch` or `--repo` on macOS, Linux and
WSL), the script ignores this copy and clones into the folder you give instead, as in Option 1.

## Using the sandbox

When the sandbox is ready, the script opens <http://localhost:3000>. Keep the window that's running the
script open while you use the sandbox. To learn how to load a manifest and test your extension, see the
[sandbox README](../README.md).

- **To stop the sandbox**, press **Ctrl+C** in that window. On Windows, if you're asked
  `Terminate batch job (Y/N)?`, type **Y**.
- **To start it again**, run the same command again. After the first run, this only takes a few
  seconds.
- **To start it without the script**, run `npm run dev` in the `radiologists/tools/extensions-sandbox`
  folder, then open <http://localhost:3000>.

## Getting the latest version

- **Option 1 (the script cloned the repository):** run the script again. It fetches the latest commits
  and updates your clone, then reinstalls the dependencies if they changed. Updates only move your clone
  forward: if you changed files in it, or committed to it, it isn't updated, and the script tells you so.
  Add `-SkipUpdate` (`--skip-update`) to start the sandbox without updating.
- **Option 2 (your own copy):** run `git pull`, or download and extract a new ZIP, then run the script
  again.

## Options

| Windows (`.ps1`) | macOS, Linux and WSL (`.sh`) | What it does |
| --- | --- | --- |
| `-InstallDir <folder>` | `--dir <folder>` | Folder to clone the repository into. Default: `dragon-copilot-extension-samples` in your home folder. |
| `-Branch <name>` | `--branch <name>` | Branch to set up. Default: `Partner`. |
| `-RepoUrl <url>` | `--repo <url>` | Repository to clone. Default: `https://github.com/4NK17gupta/dragon-copilot-extension-samples.git`. |
| `-SkipUpdate` | `--skip-update` | Use the existing clone as it is; don't fetch the latest commits. |
| `-ForceInstall` | `--force-install` | Run `npm ci` even if the dependencies look up to date. |
| `-SetupOnly` | `--setup-only` | Download and install only; don't start the sandbox. |
| `-NoBrowser` | `--no-browser` | Don't open the browser when the sandbox is ready. |
| `-InstallPrerequisites` | Not available | Use winget to install Git if it's missing, and the Node.js LTS version if Node.js is missing or too old. |

To see the built-in help, run one of these in the folder that contains the script:

- Windows: `powershell -ExecutionPolicy Bypass -Command "Get-Help .\setup-extensions-sandbox.ps1 -Detailed"`
- macOS, Linux and WSL: `bash setup-extensions-sandbox.sh --help`

## Setting up another branch

To try another branch, give it its own folder so it doesn't replace your current setup. For example,
for the `AIDraft_QualityCheck_UXChanges` branch:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-extensions-sandbox.ps1 -Branch AIDraft_QualityCheck_UXChanges -InstallDir $HOME\dragon-samples-aidraft
```

```bash
bash setup-extensions-sandbox.sh --branch AIDraft_QualityCheck_UXChanges --dir ~/dragon-samples-aidraft
```

If you use the same folder instead, the script switches that clone to the branch, as long as it has no
local changes. Only one sandbox can run at a time, because they all use ports 3000 and 4000.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `running scripts is disabled on this system` | Start the script with `powershell -ExecutionPolicy Bypass -File ...`, as shown above. |
| Git, Node.js or npm is missing or too old | Install or update it using the link the script shows, open a **new** terminal so it's found, then run the script again. On Windows, you can add `-InstallPrerequisites` instead. |
| `The sandbox needs ports 3000 and 4000, but these are in use` | If the sandbox is already running in another window, use that one, or stop it with Ctrl+C. Otherwise, find the program using the port and close it. On Windows: `Get-NetTCPConnection -State Listen -LocalPort 3000,4000`. On macOS and Linux: `lsof -nP -iTCP:3000 -iTCP:4000 -sTCP:LISTEN`. |
| `... has local changes, so it wasn't updated` or `... can't switch to ...` | You changed files in the clone. Commit, stash (`git stash`) or discard them, or use `-InstallDir` (`--dir`) to set up a fresh copy in another folder. |
| `... is a clone of '...', not ...` or `... already exists and isn't a git clone` | The folder holds something else. Use `-InstallDir` (`--dir`) to choose another folder. |
| `npm ci` or `git clone` fails with network errors | Check that you can reach `github.com` and `registry.npmjs.org`. Behind a proxy, run `npm config set proxy http://<proxy>:<port>`, `npm config set https-proxy http://<proxy>:<port>` and `git config --global http.proxy http://<proxy>:<port>`, then run the script again with `-ForceInstall` (`--force-install`). |
| `Filename too long` or `ENAMETOOLONG` on Windows | Use a shorter folder, for example `-InstallDir C:\src\dragon`. |
| The sandbox seems broken after an update | Run the script again with `-ForceInstall` (`--force-install`) to reinstall the dependencies. |
| The browser doesn't open | Open <http://localhost:3000> yourself. |
