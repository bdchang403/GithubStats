# Fix PR Data Extraction & CSV Logging

Copilot, we are currently trying to extract three new pieces of data for Pull Requests and write them to `github_activity_log.csv`:
1. Time to first review (hours)
2. # review comments count
3. List of requested reviewers

You previously struggled with this. Here is the exact root cause and the step-by-step fix you need to apply.

## 1. The Root Cause in `src/repo_processor.js`
The current code suffers from a **race condition / out-of-order execution**:
- The `logs.push({ ... })` for a Pull Request is happening **on line 437**.
- However, the API call to fetch reviews (`fetchGitHubPaginated(..., pulls/${prNum}/reviews...)`) happens **on line 474**, which is *after* `logs.push()`. 
- Because `logs.push()` happens before we know the review data, the log entry misses the requested data.
- Also, `logs.push()` currently isn't pushing `requested_reviewers`, which are available earlier in `prDetailres`.

## 2. Fix Step 1: Extract Requested Reviewers from `prDetail`
Locate where `prDetail` is fetched (around line 372). Extract the requested reviewers right there:
```javascript
const prDetailRes = await fetchGitHub(`${API_BASE_URL}/repos/${repoName}/pulls/${prNum}`);
const prDetail = prDetailRes ? prDetailRes.data : null;
if (!prDetail) return;

// Extract requested reviewers:
const requestedReviewersObj = prDetail.requested_reviewers || [];
const requestedReviewers = requestedReviewersObj.map(r => r.login).join(', ');
```

## 3. Fix Step 2: Refactor or Move `logs.push()`
Move the `logs.push()` payload *down* so it runs **after** `reviewsRes` is fetched and evaluated, OR store a reference to the log object and update it after reviews are evaluated. 

If moving down, wait until after this block:
```javascript
reviewsRes = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${repoName}/pulls/${prNum}/reviews?per_page=100`, 2);
```

Then evaluate the single PR's metrics:
```javascript
let prWaitTimeHours = '';
let prReviewComments = 0;

if (reviewsRes && Array.isArray(reviewsRes)) {
    prReviewComments = reviewsRes.length;
    const sortedReviews = reviewsRes
        .filter(r => r.submitted_at)
        .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    
    if (sortedReviews.length > 0) {
        const firstReviewTime = new Date(sortedReviews[0].submitted_at);
        if (firstReviewTime > createdAt) {
            prWaitTimeHours = ((firstReviewTime - createdAt) / (1000 * 3600)).toFixed(2);
        }
    }
}
```

Now execute your `logs.push()` including the new fields:
```javascript
logs.push({
    // ... all existing fields like Timestamp, Repository, etc. ...
    "Time to First Review (Hours)": prWaitTimeHours,
    "Review Comments Count": prReviewComments,
    "Requested Reviewers": requestedReviewers
});
```
Make sure `logs.push()` is still called even for unmerged PRs (just with empty/zero values if `reviewsRes` wasn't fetched for them).

## 4. Fix Step 3: Update CSV Headers in `index.js`
In `index.js` (around line 190), locate the `logCols` array used to write to `github_activity_log.csv`. You must add the three new columns so they get written:

```javascript
const logCols = ['Timestamp', 'Repository', 'Capability', 'Action', 'User', 'Date', 'Environment', 'Cross-Ref ID', 'Associated PR', 'ID', 'Message',
    'Branch Duration (Hours)', 'Review Time (Hours)', 'LOC Changed', 'PR Size (Commits)', 'Target Branch',
    'Time to First Review (Hours)', 'Review Comments Count', 'Requested Reviewers']; // <--- ADDED THESE
```
Note: Since you added new columns to `github_activity_log.csv`, deleting the existing `github_activity_log.csv` before the next run is highly recommended to avoid CSV column mismatch errors.
