---
kind: evidence_labels
name: Evidence labels v2, five labels with enforced rules (Architect)
schema_version: 1
notes: v2 adds strength and rules. Established science above Experimental above Theoretical above Our hypothesis. Demonstrated commercial use is a separate dimension and has no strength. Only paper, review, technical report and standard sources count toward Established science.
---
labels:
  - key: established_science
    name: Established science
    strength: 4
    definition: "A mechanism or result supported by replicated findings or recognised standards, consistent across independent sources."
    criteria: "Needs at least two independent retrieved sources, or one authoritative review or standard. A single study, a patent, a preprint or a company page does not qualify alone."
    rules:
      any_of:
        - min_sources: 2
          source_types: [peer_reviewed_paper, review_article, technical_report, standard_regulatory]
          requires_test_data: false
        - min_sources: 1
          source_types: [review_article, standard_regulatory]
      allow_no_sources: false
    examples:
      - "Water activity below a known threshold limits growth of most spoilage microbes, confirmed in standards and reviews."
  - key: demonstrated_commercial_use
    name: Demonstrated commercial use
    definition: "The approach is documented in a real product or process in use outside the lab."
    criteria: "Needs a retrieved source naming the product, process or user. A claim of capability without a named real-world use does not qualify."
    rules:
      any_of:
        - min_sources: 1
          source_types: [company_web, technical_report, trade_press, standard_regulatory, peer_reviewed_paper]
      allow_no_sources: false
    examples:
      - "A named packaging film used in commercial packs for oxygen-sensitive products, documented by the maker and a second source."
  - key: experimental
    name: Experimental
    strength: 2
    definition: "Reported in a study, pilot or test, but not replicated or shown at commercial scale."
    criteria: "Use for single peer-reviewed studies, preprints, patents reporting test data, and company claims not independently confirmed. State the scale and conditions in the rationale."
    rules:
      any_of:
        - min_sources: 1
          source_types: [peer_reviewed_paper, review_article, technical_report, preprint, company_web]
        - min_sources: 1
          source_types: [patent]
          requires_test_data: true
      allow_no_sources: false
    examples:
      - "A lab-scale study showing reduced oxidation with an encapsulated antioxidant in one product matrix."
  - key: theoretical
    name: Theoretical
    strength: 1
    definition: "Plausible from mechanism or analogy, with no direct test in a relevant system."
    criteria: "Use when sources describe a mechanism or a claimed idea but show no tested result for this use. A patent without test data is Theoretical."
    rules:
      any_of:
        - min_sources: 1
      allow_no_sources: false
    examples:
      - "A technique proven in pharmaceutical tablets that has never been tested in a food matrix."
  - key: our_hypothesis
    name: Our hypothesis
    strength: 0
    definition: "An inference made by this system, not stated by any retrieved source."
    criteria: "Use for any connection, transfer or prediction you reasoned yourself. The rationale must say what it is based on and how it could be tested."
    rules:
      allow_no_sources: true
    examples:
      - "Applying a barrier approach used in medical packaging to a snack pack may extend shelf life; no source tests this."
