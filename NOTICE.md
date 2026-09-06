# Third-party components

## openMotor
The internal ballistics engine is [openMotor](https://github.com/reilleya/openMotor)
by Andrew Reilley, licensed GPLv3. It is not redistributed here — setup clones it
onto your machine, pinned to one commit.

On a machine with no C compiler, setup adds one file to that local clone:
`mathlib/_find_perimeter_cy.py`, a pure-Python stand-in for openMotor's compiled
perimeter finder. It exists only so `motorlib` can be imported. BATES motors — all
this app optimises — never call it, and it raises rather than returning a made-up
number if any other grain geometry does. Install a compiler and re-run setup to
build the real one.

## Plotly.js

The web app serves Plotly from disk so it works offline. 


if i forgor to credit you i am sorry but please dont sue me lol im just trying to optimize my fucking rockets leave me alone scary lawyer man
