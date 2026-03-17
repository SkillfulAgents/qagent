# Google Search

This feature covers the core Google Search flow: entering a query from the homepage and viewing results.

## Homepage

### Components
- **Google logo** — centered logo image above the search bar.
- **Search bar** (`role='combobox'`) — text input for typing queries; supports autocomplete suggestions.
- **"Google Search" button** — submits the query.
- **"I'm Feeling Lucky" button** — navigates directly to the top result.

### Interactions
- Clicking the search bar or typing activates autocomplete suggestions.
- Pressing Enter or clicking "Google Search" navigates to the results page.

## Search Results Page

### Components
- **Search bar** — pre-filled with the submitted query; editable for follow-up searches.
- **Result list** — ordered list of organic results, each with a title link, URL breadcrumb, and snippet.
- **Knowledge panel** — contextual info card shown on the right for well-known topics.
- **"People also ask" section** — expandable related questions.
- **Image/video results** — inline media carousel when relevant.
- **Pagination** — "Next" link at the bottom for additional pages.

### Interactions
- Clicking a result title navigates to the external page.
- Clicking a "People also ask" question expands the answer inline.
- Editing the search bar and pressing Enter performs a new search.
