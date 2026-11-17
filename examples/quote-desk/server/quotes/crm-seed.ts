// Fictional seed data: every company, person and number is invented, and
// every email address is on the reserved .invalid domain. Generated from the
// original demo's JSON seed.
import type { Crm } from "../../shared/types.ts"

export const CRM_SEED: Crm = {
  accounts: [
    {
      account_id: "ACC-1001",
      name: "Schrute Farms B&B",
      industry: "Hospitality",
      territory: "Scranton",
      contacts: [
        {
          name: "Mara Lind",
          title: "Office manager",
          email: "mara.lind@schrute-farms.demo.invalid",
        },
      ],
    },
    {
      account_id: "ACC-1002",
      name: "Lackawanna Legal Partners",
      industry: "Legal",
      territory: "Scranton",
      contacts: [
        {
          name: "Owen Park",
          title: "Operations partner",
          email: "owen.park@lackawanna-legal.demo.invalid",
        },
      ],
    },
    {
      account_id: "ACC-1003",
      name: "Keystone Dental Group",
      industry: "Healthcare",
      territory: "Stamford",
      contacts: [
        {
          name: "Priya Nair",
          title: "Practice director",
          email: "priya.nair@keystone-dental.demo.invalid",
        },
      ],
    },
    {
      account_id: "ACC-1004",
      name: "Bluebird Logistics",
      industry: "Logistics",
      territory: "Yonkers",
      contacts: [
        {
          name: "Sam Okafor",
          title: "Procurement lead",
          email: "sam.okafor@bluebird-logistics.demo.invalid",
        },
      ],
    },
  ],
}
