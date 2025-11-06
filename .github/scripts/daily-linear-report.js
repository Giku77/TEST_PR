const {
  LINEAR_API_KEY,
  NOTION_API_KEY,
  NOTION_DATABASE_ID,
  TZ_OFFSET_HOURS = "9",
} = process.env;

if (!LINEAR_API_KEY || !NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error("Missing envs");
  process.exit(1);
}

// 어제 시각 계산 (UTC 기준)
const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

const linearQuery = `
  query DailyIssues($updatedAfter: DateTime!) {
    issues(
      filter: { updatedAt: { gte: $updatedAfter } }
      orderBy: updatedAt
      first: 100
    ) {
      nodes {
        identifier
        title
        url
        state { name }
        assignee { name }
      }
    }
  }
`;

async function fetchLinear() {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": LINEAR_API_KEY,
    },
    body: JSON.stringify({
      query: linearQuery,
      variables: { updatedAfter: yesterday.toISOString() },
    }),
  });
  if (!res.ok) {
    throw new Error("Linear error: " + (await res.text()));
  }
  const json = await res.json();
  return json.data.issues.nodes;
}

function makeReport(issues) {
  if (!issues.length) return "오늘 변경된 이슈가 없습니다.";
  return issues
    .map((i) => {
      const assignee = i.assignee?.name ? `, 담당: ${i.assignee.name}` : "";
      return `- **${i.identifier}** ${i.title} (상태: ${i.state?.name ?? "?"}${assignee})\n  - ${i.url}`;
    })
    .join("\n");
}

async function createNotionPage(content) {
  const offset = parseInt(TZ_OFFSET_HOURS, 10) || 0;
  const kstNow = new Date(now.getTime() + offset * 60 * 60 * 1000);
  const yyyy = kstNow.getUTCFullYear();
  const mm = String(kstNow.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kstNow.getUTCDate()).padStart(2, "0");
  const title = `Linear 일간보고 ${yyyy}-${mm}-${dd}`;

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Name: {
          title: [{ text: { content: title } }],
        },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content } }],
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error("Notion error: " + (await res.text()));
  }
}

(async () => {
  try {
    const issues = await fetchLinear();
    const report = makeReport(issues);
    await createNotionPage(report);
    console.log("done:", issues.length, "issues");
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
