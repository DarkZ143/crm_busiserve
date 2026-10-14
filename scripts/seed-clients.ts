import { randomUUID } from "node:crypto";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
  });
}

const db = getFirestore();

const COUNT = 60;
const COLLECTION = "clients";
const ORIGINAL_ID = "Jhh3IRBDBAx9EFfLMlBI";

const names = [
  "Aarav Sharma",
  "Priya Verma",
  "Rohan Gupta",
  "Ananya Singh",
  "Karan Mehta",
  "Neha Kapoor",
  "Aditya Kumar",
  "Sneha Patel",
  "Arjun Malhotra",
  "Ishita Joshi",
  "Rahul Mishra",
  "Pooja Yadav",
  "Vikram Sinha",
  "Kavya Rao",
  "Aman Khanna",
  "Simran Kaur",
  "Nikhil Jain",
  "Meera Das",
  "Devansh Roy",
  "Ritika Bose",
];

const companies = [
  "NovaTech Solutions",
  "BrightPath Systems",
  "CloudNest Technologies",
  "Vertex Digital",
  "BluePeak Innovations",
  "NextWave Software",
  "CoreBridge Consulting",
  "PixelCraft Labs",
  "GreenOrbit Services",
  "Skyline Infotech",
  "PrimeStack Technologies",
  "UrbanByte Solutions",
];

const industries = [
  "IT",
  "Healthcare",
  "Finance",
  "Education",
  "Manufacturing",
  "Retail",
  "E-commerce",
  "Consulting",
  "Marketing",
  "Logistics",
];

const addresses = [
  "Noida",
  "Gurugram",
  "New Delhi",
  "Mumbai",
  "Pune",
  "Bengaluru",
  "Hyderabad",
  "Jaipur",
  "Lucknow",
  "Chennai",
  "Kolkata",
  "Thane",
];

const requirementsList = [
  "CRM, login, notification",
  "Customer management and reporting",
  "Sales dashboard and lead tracking",
  "Role-based access and analytics",
  "Inventory management and notifications",
  "Employee management and attendance",
  "Client onboarding and document management",
  "API integration and automated workflows",
];

const objectivesList = [
  "Improve business operations",
  "Automate customer management",
  "Streamline sales workflows",
  "Improve reporting and analytics",
  "Centralize business information",
  "Enhance team productivity",
];

const statuses = ["active", "active", "active", "inactive"];
const approvalStatuses = [
  "approved",
  "approved",
  "approved",
  "pending",
  "rejected",
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function randomDate(daysBack = 90): Date {
  return new Date(Date.now() - Math.random() * daysBack * 24 * 60 * 60 * 1000);
}

function makePhone(index: number): string {
  // Reserved dummy-style values: never use for real outreach.
  return `00000${String(index).padStart(5, "0")}`;
}

async function main() {
  // Preserve the original record and verify the target collection.
  const originalRef = db.collection(COLLECTION).doc(ORIGINAL_ID);
  const originalSnap = await originalRef.get();

  if (!originalSnap.exists) {
    throw new Error(
      `Original record not found in "${COLLECTION}". Check collection name.`,
    );
  }

  const original = originalSnap.data()!;

  const batch = db.batch();
  const createdIds: string[] = [];

  for (let i = 1; i <= COUNT; i++) {
    const ref = db.collection(COLLECTION).doc();
    const name = pick(names);
    const email = `dummy.${randomUUID()}@example.com`;
    const approvalStatus = pick(approvalStatuses);
    const createdAt = randomDate();
    const isReviewed = approvalStatus !== "pending";

    const record = {
      // Same schema as the original record
      approvalComments:
        approvalStatus === "approved"
          ? "Dummy approval for testing"
          : approvalStatus === "rejected"
            ? "Dummy rejection for testing"
            : "",
      approvalStatus,
      assignedProductManager: "",
      businessAddress: pick(addresses),
      clientId: `CLI-${ref.id.slice(0, 8).toUpperCase()}`,
      clientName: name,
      companyName: pick(companies),
      contactNumber: makePhone(i),
      contactPerson: `00000${String(i + 100).padStart(5, "0")}`,
      createdAt,
      createdBy: pick(["BIS0002", "BIS0003", "BIS0004"]),
      id: ref.id,
      industry: pick(industries),
      internalNotes: "TEST DATA - safe to delete",
      objectives: pick(objectivesList),
      officialEmail: email,
      officialEmailNormalized: email.toLowerCase(),
      onboardingDate: createdAt.toISOString().slice(0, 10),
      requirements: pick(requirementsList),
      reviewedAt: isReviewed ? createdAt : null,
      reviewedBy: isReviewed ? original.reviewedBy || "" : "",
      status: pick(statuses),
      updatedAt: createdAt,
    };

    batch.set(ref, record);
    createdIds.push(ref.id);
  }

  await batch.commit();

  console.log(`Successfully created ${createdIds.length} dummy clients.`);
  console.log("Original document preserved:", ORIGINAL_ID);
  console.log("New document IDs:", createdIds);
}

main().catch((error) => {
  console.error("Failed to seed clients:", error);
  process.exitCode = 1;
});
