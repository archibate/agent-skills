# Testing Prompts

Testing LLM prompts in a unit test flavor. The pass rate is only honest while the prompt stays independent of the samples it is scored on.

## 1. NEVER hard-code incidents in prompts

Do not hard-code an incident shape just to make a test case pass: over-fitting risk is far more dangerous than a single sample failure.

Accept the fact that LLM tests can never reach 100% pass rate - it's typically not the responsibility of your prompt skill, but the model capability. Even flagship model can't do everything, not to say weak models. Upgrade model if test cases keep failing instead of over-fitting prompts.

Spare prompt tuning only if it improves many test cases across multiple clusters.

## 2. Split test cases into eval/test set (no data leaking)

If you decide to tune your prompt to pursuit better pass rate: tune *only for eval-set*, NEVER for test-set. You are allowed to maximizing eval-set pass rate, NEVER test-set pass rate.

**Why:** Test-set pass rate MUST remain an honest mirror, not for benchmaxxing - that would cause severe *over-fitting* risk. If you deplete both eval/test-set for benchmaxxing, no way to evaluate if the high pass rate is over-fit or genuine prompt skill.

A severe pass rate drop from eval-set to test-set is a signal of over-fit -> re-derive your prompt from first-principles to minimal, instead of benchmaxxing prompt tune.

## 3. Avoid sample clustering acrossing eval and test

E.g.: "Order a bottle of tea" and "Buy a cup of tea" are clustering samples. This would incur test-set benchmaxxing risk. If you fit the "Order a bottle of tea" sample in eval-set by hard-coding "tea" into prompt, this would make the "Buy a cup of tea" sample in test-set pass, dilutes the honesty of test-set.
