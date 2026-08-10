# Testing Prompts

Test LLM prompts with a unit-test-style workflow. A pass rate is honest only while the prompt remains independent of the samples on which it is scored.

## 1. NEVER hard-code individual cases into prompts

Do not hard-code the shape of a specific incident just to make one test case pass: the risk of overfitting is far more dangerous than a single sample failure.

Accept that LLM tests can never reach a 100% pass rate. Failures are typically a limitation of the model's capabilities rather than the prompt skill: even flagship models cannot do everything, let alone weaker models. If test cases keep failing, upgrade the model instead of overfitting the prompt.

Tune the prompt only when doing so improves many test cases across multiple clusters.

## 2. Split test cases into evaluation and test sets (no data leakage)

If you decide to tune your prompt to pursue a better pass rate, tune *only on the evaluation set*, NEVER on the test set. You may maximize the evaluation-set pass rate, NEVER the test-set pass rate.

**Why:** The test set MUST remain held out so that its pass rate stays an honest measure, not a benchmaxxing target—that would create a severe risk of *overfitting*. If you exhaust both the evaluation and test sets through benchmaxxing, there is no way to determine whether a high pass rate reflects overfitting or genuine prompt quality.

A severe drop in pass rate from the evaluation set to the test set signals overfitting → re-derive a minimal prompt from first principles instead of benchmaxxing through prompt tuning.

## 3. Avoid clustering similar samples across evaluation and test sets

For example, "Order a bottle of tea" and "Buy a cup of tea" are clustered samples. This creates a risk of benchmaxxing the test set. If you fit the evaluation-set sample "Order a bottle of tea" by hard-coding "tea" into the prompt, you may also make the test-set sample "Buy a cup of tea" pass, compromising the integrity of the test set.
