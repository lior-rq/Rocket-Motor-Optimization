# Rocket Optimization

Lior's Really Good™ Rocket Optimizer, created by Lior Benshoshan.

A local web application that searches for solid rocket motor designs. It runs
[openMotor](https://github.com/reilleya/openMotor)'s internal ballistics engine
headlessly, evaluating thousands of candidate motors against a set of limits and
returning the ones that satisfy them. Results are exported as `.ric` files that open
directly in openMotor.

The application is built for BATES grain geometries.

![The optimizer](docs/screenshot.png)

The [field guide](docs/Optimizer-Field-Guide.pdf) documents the interface panel by
panel. Its [HTML source](docs/guide.html) is the file the PDF is rendered from.

## Installation

For most people: [download the latest release](https://github.com/lior-rq/Rocket-Motor-Optimization/releases/latest),
extract it, and run what's inside. No Python, git, or compiler needed. It opens in its
own window rather than a browser tab, and keeps its files under
`Documents/Rocket Optimizer/` instead of the project folder.

The first launch shows a one-time warning, since these builds are not signed:

- **Windows:** "Windows protected your PC" -> **More info** -> **Run anyway**.
- **macOS:** open it once, then **System Settings -> Privacy & Security -> Open Anyway**.

To run it from source instead:

```bash
python3 app.py
```
If you have a mac (supreme) you should be fine because it will auto install everything,
however make sure you have 3.9 < python version < 3.13, otherwise it will blow up

The first run builds an environment before starting: a `.venv` in the project folder,
the packages listed in `requirements.txt`, and a clone of openMotor pinned to a known
commit. It asks for confirmation first and writes nothing outside the project folder.
The application then opens at `http://localhost:8420`.

Requirements are Python 3.9 to 3.13, and `git`. The upper bound is where the pinned
wheels stop. `requirements.txt` carries two sets: Python 3.10 and later get numpy 2
and the versions built for 3.13, while 3.9 keeps numpy 1, which is the last release
that supports it. Setup checks the version before installing anything, and will use a
supported interpreter if one is installed alongside a newer one.

3.14 is not reachable yet. scipy and scikit-image both require 3.11 or later at the
versions that support it, which is workable, but scikit-fmm publishes no 3.14 wheel at
any version.

A C++ compiler is needed on macOS and Linux, because scikit-fmm publishes Windows
wheels only and is built from source everywhere else. `xcode-select --install` covers
macOS and `apt install build-essential python3-dev` covers Debian. Separately,
openMotor contains one compiled module that BATES simulations never call; if that one
fails to build, setup substitutes a pure-Python stand-in which raises an error should a
grain geometry ever require the real thing.

To build the environment without the confirmation prompt, run `scripts/setup_env.sh`
or `python3 bootstrap.py --yes`.

## The motor

Whatever `.ric` file is placed in `motor/` is the motor that gets optimised. No
filename is significant. The folder ships empty and the application does nothing until
a motor is placed there, since a motor design belongs to whoever made it and not in
this repository.

For a motor to experiment with, `python tests/sample_motor.py motor/sample.ric` writes
a generic six-grain KNSB motor.

## What can be optimised

Grain outer diameter, stack length and the propellant are read from the `.ric` file
and never modified. Nine dimensions can be varied, plus the grain count:

| Variable | Description |
|---|---|
| `core_1` … `core_6` | core diameter of each grain, numbered from the forward end |
| `throat` | nozzle throat diameter |
| `exit` | nozzle exit diameter, floored at 1.15 × throat |
| `throat_length` | nozzle throat length |
| grain count | how many equal grains the stack is cut into, within a range; off by default |

Each dimension takes a machining step, 0.05 in by default. The optimiser only returns
values that fall on that grid. Bounds, objectives and limits are configured in the
application. The limits start at peak chamber pressure 500 psi, peak Kn 225, peak mass
flux 1.05 lb/in²s, port/throat ratio 1.4 and peak core Mach 1.0, which are
amateur-practice numbers rather than the case rating a `.ric` file usually carries.
openMotor only warns when a core goes supersonic, so the search holds that one itself.

Nineteen metrics are available as objectives or limits. Each can be maximised,
minimised or driven toward a target value. Selecting two produces a trade-off curve
rather than a single result. Some limits are offered switched off, among them residual
propellant: the share of the load still unburned when the motor quits, because thrust
fell under openMotor's burnout threshold or the pressure fell out of the propellant's
burn-rate range. It is the sliver left when cores of different sizes finish at
different times.

Rail exit speed is the one metric that needs the rocket described as well as the
motor: the hardware mass (everything that flies except propellant), the rail length
and its angle from vertical. Each design is flown up the rail on its own thrust curve
at that mass plus its own propellant, with the mass held at its liftoff value and
drag ignored, which is what the team's standalone calculation does too. The
constraints page also reports the heaviest hardware the loaded motor would carry to
the target speed.

## How results are produced

Two search modes are available. The full search runs a genetic search directly against
openMotor, so every candidate is a real simulation. The surrogate search spends half
its budget on a space-filling sample, then works in rounds: it trains models on every
simulation so far, runs NSGA-II against the models, and simulates the designs the
models propose. Each round puts the burns where the trade-off curve is, so the models
are most accurate exactly there. On the reference motor it reaches a fuller curve than
the full search on the same budget. It is marked beta in the application because it
has been measured on fewer configurations.

Every design that appears in a result has been simulated in openMotor at the
verification timestep with all search-time safety margins removed. Surrogate models
influence which designs are proposed, never which are reported. Up to ninety designs
are kept, spread along the trade-off curve when the front is longer than that.

While a run is going, the best legal motor found so far can be downloaded as a `.ric`
from the waiting screen. It is the highest-scoring design of any generation so far,
which for a single-objective run is simply the best motor yet.

The search runs at a 0.01 s timestep and verification at 0.002 s. The two disagree
slightly and in different directions depending on the metric. Peak mass flux is a
finite difference and grows as the timestep shrinks, total impulse is an integral, and
pressure and Kn are invariant. `runner.timestep_bias` measures the ratio on the loaded
motor and adjusts the search-time limits accordingly, so that a design sitting on a
limit during the search still satisfies it after verification.

A single search is not guaranteed to find the global front, so a run divides its
budget across several independent searches and reports the non-dominated set of
everything they find. Four presets set the budget and the search count together;
population size and generation count are derived from them.

| Preset | Budget | Searches | Per search | Population × generations |
|---|---|---|---|---|
| Quick | 2,400 | 2 | 1,200 | 40 × 30 |
| Standard | 4,800 | 3 | 1,600 | 40 × 40 |
| Thorough | 10,000 | 5 | 2,000 | 40 × 50 |
| Extreme | 24,000 | 8 | 3,000 | 60 × 50 |

These come from a measurement on a nine-dimension, two-objective configuration at a
0.05 in step: the best motor stopped improving a little past 2,000 simulations, and
independent searches stopped paying at about five. The boxes behind them are editable
once *I know what I'm doing* is ticked.

Time estimates are not shown until the diagnostic on the settings page has measured
this machine at these settings, since a rate the program has not measured is a guess.
The settings page also checks that the machine is plugged in, kept awake and set to
its highest performance mode, since a search that throttles partway through makes the
measurement wrong.

## Searching the grain count

Every limit in the application is a peak limit, and the grain count sets the
peak-to-mean ratio of the burn: more, shorter grains means more end faces and a more
regressive burn; fewer, longer grains burns progressive. Burn area is equal at
ignition and burnout when a grain is (3D + d)/2 long, so the count that lands near
that length is usually the one that packs the most impulse under a pressure or Kn
ceiling. The count is therefore worth searching, but it is not a dimension like the
others: a design vector at five grains and one at eight have different lengths.

The stack length is held and cut into every count in the range. Each count is a
separate search over the fixed-count space, and the search internals never learn
that the count exists. Three passes keep that affordable:

1. **Screen.** The closed-form Kn and port/throat checks run per count. A count that
   no core and throat can make legal is dropped before any simulation.
2. **Short search.** Every surviving count gets a search of ten generations at the
   preset's population. Counts are ranked on the hypervolume of their verified
   front, or on the best legal score for a single objective.
3. **Full search.** The best two counts, plus any within two percent of the leader,
   get the full preset budget, seeded with their short-search survivors. The
   reported designs are the non-dominated set across every count, compared on
   metrics alone.

A free count frees every core, and mandrel groups are unavailable, since both need a
fixed count to mean anything. The report and the diagnostics profile list every
count with its outcome.

## Two properties that reduce the search space

Grain order does not affect the result. In openMotor's model, impulse, pressure and
burn time depend only on the multiset of core diameters and not on their arrangement,
which `scripts/verify_ordering.py` checks against the simulator. Order affects mass
flux and port/throat ratio, and both are most favourable with the largest core aft.
Cores are therefore stored sorted, which removes a 720-fold degeneracy.

Several quantities are closed-form. Port/throat ratio, initial Kn, propellant mass and
ignition chamber pressure are exact results for BATES geometry and are computed in
`design.py` rather than learned. Only quantities that require integrating the whole
burn are modelled. The application uses the same closed-form expressions to report the
size of the configured design space, and to rule out regions that no legal motor can
occupy before any simulation runs.

## Output

Each completed run writes a report to `reports/` as a PDF. The report is derived
entirely from the run: hardware and limits are read from the motor and the
configuration, and the trade-off curve and option tables are built from the verified
designs. A run that finds no legal design is documented in the most detail, including
which limit could not be met and, where burning area is closed-form, a proof that no
core diameter would have satisfied it.

Three further downloads are available on request. The design sheets are one PDF per
design on the trade-off curve, with the dimensions to machine to. The motor file is one
RASP `.eng` holding every design, which OpenRocket and RockSim read directly and list
as separate motors; each curve is a real openMotor run at the verification timestep, so
it agrees with the report. The `.eng` format carries a single total-mass field and this
application never models hardware, so that field holds the propellant mass alone and
the casing has to be added before the file is used for an altitude simulation. The file
says so in its header. The openMotor files are a zip of one `.ric` per design.

`outputs/` mirrors the most recent optimisation and nothing else. It is emptied and
rewritten on every run, so its contents always describe the motor that was just
optimised. It contains `result.json`, one `.ric` file per legal design, and the report
figures. None of it is source, and none of it is committed.

## Checking build robustness

The optimiser works from nominal dimensions, so a design sitting exactly on a limit is
a coin flip once real tolerances are applied. The robustness check, available on a
design once a run has finished, simulates it 400 times with tolerances drawn onto the
hardware and propellant, and reports the share of builds that still satisfy every
enabled limit, with a 95% confidence interval and the exceedance probability of each
limit individually.

Ten tolerance fields are available, each entered as a standard deviation or a uniform
half-width. Core diameter and grain length are drawn once per grain, since each is a
separate reamer or casting pass; the nozzle dimensions, burn-rate coefficients,
density, nozzle efficiency and ambient pressure are drawn once for the whole motor,
since they come from one batch or one machining setup. Core diameter, throat and the
burn-rate coefficient are on by default at values plausible for a home shop and a
hand-mixed batch; the rest start switched off and are meant to be replaced with what
your equipment and propellant actually do.

The check runs at the search's 0.01 s timestep rather than the finer verification
step, since several hundred builds at the fine timestep would spend minutes sharpening
a distribution the tolerance assumptions already dominate.

## Development

```bash
.venv/bin/python scripts/verify_ordering.py   # check the core-sorting assumption
.venv/bin/python -m pytest tests/ -q
```

### The page

The interface is a React app in `frontend/` (Vite, TypeScript, Tailwind, Motion for
the animation, react-three-fiber for the motor cutaway, Plotly for the charts). The
built page lives in `app/static/` and is committed, so running from source needs no
Node at all. Editing the frontend does:

```bash
cd frontend
npm ci
npm run dev      # hot reload at http://localhost:5173, proxied to app.py on 8420
npm run build    # writes app/static/; commit the result
```

The server is unchanged by any of this: `app/server.py` speaks JSON, and the page
is the only client. A running search is streamed to it over server-sent events
(`/api/jobs/{id}/events`); `/api/jobs/{id}/live` still answers a poll.

### Building the desktop app

```bash
pip install -r requirements.txt -r requirements-desktop.txt
python scripts/build_desktop.py
```

Builds the openMotor vendor tree, freezes the app with PyInstaller, runs it headlessly
to confirm the frozen build actually works (`desktop.py --smoke`), and writes a zip to
`dist/`. PyInstaller cannot cross-compile, so this has to run once on macOS and once on
Windows; `.github/workflows/release.yml` does both on a pushed `vX.Y.Z` tag (which must
match `rocketopt.__version__`) and attaches the two zips to a GitHub Release. During
development, `python desktop.py` runs the same window from source, no build needed.

## Licence

You must be forklift certified to use this repo lol
