# Deployment guide (non-technical)

Never paste a key into chat, email or this repository. Keys go only into the hosting dashboard (step 6).
Wording of buttons in third-party dashboards may differ slightly from what is written here; the intent of each step is what matters.

## Part A: accounts (no code needed)
1. Use one company email for every account below.
2. **GitHub**: sign up, then create a **private** repository named `ph-rd-agent`.
3. **Supabase**: sign up, create a project on the **Free** plan, pick the region closest to you, and save the database password in a password manager.
4. **Render**: sign up. Do not add a paid service.
5. **Google (Gemini)**: create a project used only for P&H, turn on billing (your decision), set a budget alert, and create an API key inside it. Confirm it shows as paid tier.
6. **OpenAlex**: create an account, verify your email, copy the API key from Settings. Add no payment method.

## Part B: first deployment
1. **Upload the code to GitHub.** Unzip the package. In your new repository choose "Add file" then "Upload files" and drag the contents in (the folders `worker`, `supabase`, `docs`, and the loose files at the top: `Dockerfile`, `render.yaml`, `.dockerignore`, `.gitignore`, `.env.example`). If the website refuses because of the number of files, upload one folder at a time, or use GitHub Desktop.
2. **Supabase settings.**
   - Authentication: turn OFF "Allow new users to sign up".
   - Authentication → Users → Add user: your email and a strong password, with "auto confirm" ticked. Repeat for each teammate later.
   - Copy three things for the next step: the Project URL; the public key (anon / publishable); and the **Session pooler** connection string (Connect button), with `[YOUR-PASSWORD]` replaced by your database password.
3. **Render.** New → Blueprint → connect your GitHub → choose the repository. Render reads `render.yaml` and asks for each value. Enter:
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `GEMINI_API_KEY`, `OPENALEX_API_KEY`, `CONTACT_EMAIL`, `FOUNDER_EMAIL` (the email you used in step 2). Then Apply.
4. **Check it is alive.** When Render says Live, open `https://<your-service>.onrender.com/health`. You should see `{"ok":true}`. If you see "Setup incomplete. Missing: ..." a value is missing: add it in Render → Environment and redeploy.
5. **Open** `https://<your-service>.onrender.com/setup` and sign in with your founder email and password. The first start creates the database tables and loads the instruction files by itself.
6. **Readiness panel.** Every key should show a green tick. Values are never displayed.
7. **Budgets.** Enter monthly budget, per-investigation cap, an optional test-run cap and the exchange rate (₹ per US$), then Save.
8. **Add the model.** "List available models" asks Google which models your key can use. Pick one with Add. Then "Add price" (enter the numbers from Google's pricing page and where you read them), then "Verify price".
9. **Verify the data policy.** Read Google's data-use terms for the paid tier. Click "Verify data policy", enter the page URL and how long data is retained, and answer whether content is used for training.
10. **Run the conformance check.** About ten tiny calls with your key (a few rupees, recorded in the cost ledger). It must pass.
11. **Activate** the model, then **Use for all tasks**.
12. **Safe first runs, in order.** (a) Create an investigation and only look at the plan, then Reject. (b) Create one with the cap lowered to ₹20 and approve it, to watch the clean stop ("incomplete: budget reached"). (c) A normal run.

## Free-plan behaviour (until you approve the paid plan)
The free Render instance sleeps after about 15 minutes with no visits and takes up to a minute to wake. While a run is in progress keep the investigation open in your browser: the page checks in every few seconds, which keeps the service awake. If it did fall asleep mid-run, the work resumes from where it stopped when the service wakes.

## If a key was ever pasted somewhere by mistake
Revoke it at its provider and create a new one, then update it in Render → Environment.
