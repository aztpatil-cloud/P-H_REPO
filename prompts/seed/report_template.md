---
kind: report_template
name: Report template, nine sections v1 (Architect)
schema_version: 1
---
sections:
  - key: problem
    title: Problem
    instruction: "State the problem in plain language and give the measurable target. Note any correction made to the original statement and why. Keep it short."
    max_words: 150
  - key: mechanism
    title: Mechanism
    instruction: "Explain what causes the problem, sub-question by sub-question, in simple language. Mark mechanisms that rest on assumptions."
    max_words: 400
  - key: technology_discovery
    title: Technology discovery
    instruction: "List the technologies and approaches found, grouped by industry of origin. For each, give one line on what it does and where it comes from. Include approaches that were rejected, with the reason."
    max_words: 600
  - key: evidence
    title: Evidence
    instruction: "For each approach, list the supporting findings with their evidence label, rationale and verified sources. Report contrary or conflicting evidence. Do not list any claim without a retrieved source, and flag sources seen as abstract only."
  - key: technical_evaluation
    title: Technical evaluation
    instruction: "For each approach kept, explain how it works, what has been demonstrated and at what scale, and its limitations. State the single biggest weakness."
  - key: ph_application
    title: P&H application
    instruction: "Explain how each approach could be adapted to Pure & Honest products and Indian manufacturing: ingredients, equipment, scalability, effect on taste and texture, and items to check with the food regulator. Mark regulatory points as to be verified unless a retrieved source states them."
  - key: commercial_feasibility
    title: Commercial feasibility
    instruction: "Describe cost drivers, equipment needs, complexity, scalability and availability in India. Every figure must come from a retrieved source. Anything else must be shown as not estimated. Never guess a number."
  - key: experiment_proposal
    title: Experiment proposal
    instruction: "Give practical trials for the top directions, each with hypothesis, variables, control, measurement method, pass or fail criterion and a stop condition."
  - key: recommendation
    title: Recommendation
    instruction: "Rank the most promising directions and explain the ranking. For each, state confidence as low, medium or high, the biggest weakness and the next step. High means at least one verified Established science or Demonstrated commercial use finding supports it, it has been shown in a food or closely related system, and no unresolved contrary evidence. Medium means supported by verified Experimental findings in a relevant system, or established science that has not been tested in food. Low means it rests mainly on Theoretical findings or Our hypothesis. When the run had limited coverage, say so and do not use high. If the evidence is too thin to recommend anything, say so plainly and say what search or test would change that."
    max_words: 400
