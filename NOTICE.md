# Third-party components

## openMotor

The internal ballistics engine is [openMotor](https://github.com/reilleya/openMotor)
by Andrew Reilley, licensed GPLv3.

From source, it is cloned by `bootstrap.py` and kept out of this repository (see
`vendor/` in `.gitignore`). The desktop build is different: it bundles openMotor into
the app, which makes the app itself a combined work under GPLv3. That is why this
project is licensed GPLv3 too (see `LICENSE`) and why its source is public -- a build
that included openMotor without doing that would not be redistributable.

On a machine without a C compiler (skill issue), setup adds one file to that local clone:
`mathlib/_find_perimeter_cy.py`, a pure-Python stand-in for openMotor's compiled
perimeter finder. It exists only so that `motorlib` can be imported. BATES motors,
which are all this application optimises, never call it. Any other grain geometry that
reaches it raises an error rather than receiving a substituted value. Installing a
compiler and re-running setup builds the real module.

## Plotly.js

The web interface serves Plotly from disk so that it works without a network
connection. Plotly.js is licensed MIT.

## Licensing note

This project is only intented to be accessed by bill clinton and kanye west
