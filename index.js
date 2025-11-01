const express = require('express');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const app = express();
const port = process.env.PORT || 8080;

app.get('/', async (req, res) => {
  try {
    console.log('Request received');
    const credentials = {
      client_email: process.env.GA_CLIENT_EMAIL,
      private_key: process.env.GA_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    };
    const client = new BetaAnalyticsDataClient({ credentials });
    console.log('GA Client initialized');

    const PROPERTY_ID = process.env.PROPERTY_ID;
    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      metrics: [{ name: 'totalUsers' }],  // Counts all unique visitors (no double-counting)
    });
    const totalUsers = response.rows?.[0]?.metricValues?.[0]?.value || '0';
    console.log('Total Users:', totalUsers);
    res.send(totalUsers);
  } catch (error) {
    console.error('Error:', error.message);
    res.send('0');
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
});
