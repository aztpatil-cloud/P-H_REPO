---
kind: evidence_labels
name: Evidence labels v1, five labels (Architect)
schema_version: 1
---
labels:
  - key: established_science
    name: Established science
    definition: "A mechanism or result supported by replicated findings or recognised standards, consistent across independent sources."
    criteria: "Needs at least two independent retrieved sources, or one authoritative standard or review. A single study, a patent, a preprint or a company page does not qualify alone."
    examples:
      - "Water activity below a known threshold limits growth of most spoilage microbes, confirmed in standards and reviews."
  - key: demonstrated_commercial_use
    name: Demonstrated commercial use
    definition: "The approach is documented in a real product or process in use outside the lab."
    criteria: "Needs a retrieved source naming the product, process or user. A claim of capability without a named real-world use does not qualify."
    examples:
      - "A named packaging film used in commercial packs for oxygen-sensitive products, documented by the maker and a second source."
  - key: experimental
    name: Experimental
    definition: "Reported in a study, pilot or test, but not replicated or shown at commercial scale."
    criteria: "Use for single peer-reviewed studies, preprints, patents reporting test data, and company claims not independently confirmed. State the scale and conditions in the rationale."
    examples:
      - "A lab-scale study showing reduced oxidation with an encapsulated antioxidant in one product matrix."
  - key: theoretical
    name: Theoretical
    definition: "Plausible from mechanism or analogy, with no direct test in a relevant system."
    criteria: "Use when sources describe a mechanism or a claimed idea but show no tested result for this use. A patent without test data is Theoretical."
    examples:
      - "A technique proven in pharmaceutical tablets that has never been tested in a food matrix."
  - key: our_hypothesis
    name: Our hypothesis
    definition: "An inference made by this system, not stated by any retrieved source."
    criteria: "Use for any connection, transfer or prediction you reasoned yourself. The rationale must say what it is based on and how it could be tested."
    examples:
      - "Applying a barrier approach used in medical packaging to a snack pack may extend shelf life; no source tests this."
