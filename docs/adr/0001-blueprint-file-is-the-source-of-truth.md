# Blueprint file is the source of truth

Hull could infer infrastructure by scanning application code (as Encore and Klotho do) or keep it as hosted state. We decided the single source of truth is a declarative blueprint file in the repo: the studio is a visual editor for that file, bindings are generated from it, and deploy compiles it. Code scanning is brittle and is the ground Klotho died on; hosted state locks in the developers least able to leave.
