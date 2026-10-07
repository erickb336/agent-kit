# The sage report

End your work with this report, and nothing after it. The chief of staff reads many reports, so keep it short: about 2,000 tokens or fewer, with long material in files that you name. {{REPORT_GATE}} Write "none" in a field that has nothing.

```
STATUS        done, blocked or question
RESULT        the outcome, in the words your brief asks for (for example PASS or FAIL, CLEAN or FINDINGS)
EVIDENCE      each command you ran and its result; the paths of screenshots or output files
FINDINGS      for each problem: a key, high, medium or low, the location, and the steps that show it
QUESTIONS     each product question, its options and your recommendation
NOT VERIFIED  what you did not check, and why
BRANCH        the branch, its head SHA and the pull request link
```

Every claim has its evidence in the same report: the command and what it printed, or a screenshot. "It works" without a command or a screenshot is not evidence.
