GitHub repository: https://github.com/marc450/falu-pms
Push command: `git -c credential.helper="" push https://marc450:$(cat ~/.ghpat)@github.com/marc450/falu-pms.git main`

Always push changes to github after making them.
Deploy to Github using the token stored in the GITHUB_TOKEN environment variable or the project owner's credentials.

Never use "-" or any ciffers like that in your text.

Whenever an sql migration needs to be run, provide it to me directly.

ALWAYS ask the user for explicit approval before changing the calculation logic of any KPI (Avg Uptime, Avg Scrap Rate, Total BU Output, Total Swabs, or any derived metric shown in tiles or charts). Do not change KPI calculations on your own initiative, even if the current logic appears incorrect.

Supabase Data API grants: from October 30, 2026 Supabase no longer auto-exposes new public tables to the Data API. Existing tables keep their current grants and are not affected. Every CREATE TABLE migration drafted from now on must include the following grants so supabase-js can reach the table:

  ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY;
  GRANT SELECT                         ON public.<name> TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.<name> TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.<name> TO service_role;

Adjust the role list and CRUD verbs to the actual access needs, and add CREATE POLICY statements for any role that should read or write.
