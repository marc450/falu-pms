GitHub repository: https://github.com/marc450/falu-pms
Push command: `git -c credential.helper="" push https://marc450:$(cat ~/.ghpat)@github.com/marc450/falu-pms.git main`

Always push changes to github after making them.
Deploy to Github using the token stored in the GITHUB_TOKEN environment variable or the project owner's credentials.

Never use "-" or any ciffers like that in your text.

Whenever an sql migration needs to be run, provide it to me directly.

ALWAYS ask the user for explicit approval before changing the calculation logic of any KPI (Avg Uptime, Avg Scrap Rate, Total BU Output, Total Swabs, or any derived metric shown in tiles or charts). Do not change KPI calculations on your own initiative, even if the current logic appears incorrect.
