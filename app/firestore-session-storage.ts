import { SessionStorage } from "@shopify/shopify-app-session-storage";
import { Session } from "@shopify/shopify-api";
import { db } from "./firebase.server";

export class FirestoreSessionStorage implements SessionStorage {
  private collection = db.collection("shopify_sessions");

  async storeSession(session: Session): Promise<boolean> {
    try {
      await this.collection.doc(session.id).set(session.toObject());
      return true;
    } catch (error) {
      console.error("Error storing session in Firestore:", error);
      return false;
    }
  }

  async loadSession(id: string): Promise<Session | undefined> {
    try {
      const doc = await this.collection.doc(id).get();
      if (!doc.exists) return undefined;
      const data = doc.data();
      if (!data) return undefined;
      
      // Firestore stores dates as strings or Timestamps. Session expects a Date object.
      if (data.expires && typeof data.expires === 'string') {
        data.expires = new Date(data.expires);
      } else if (data.expires && data.expires.toDate) {
        data.expires = data.expires.toDate();
      }

      const session = new Session(data as ConstructorParameters<typeof Session>[0]);
      return session;
    } catch (error) {
      console.error("Error loading session from Firestore:", error);
      return undefined;
    }
  }

  async deleteSession(id: string): Promise<boolean> {
    try {
      await this.collection.doc(id).delete();
      return true;
    } catch (error) {
      console.error("Error deleting session from Firestore:", error);
      return false;
    }
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    try {
      const batch = db.batch();
      ids.forEach((id) => {
        batch.delete(this.collection.doc(id));
      });
      await batch.commit();
      return true;
    } catch (error) {
      console.error("Error deleting sessions from Firestore:", error);
      return false;
    }
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    try {
      const snapshot = await this.collection.where("shop", "==", shop).get();
      return snapshot.docs.map((doc) => {
        const data = doc.data();
        if (data.expires && typeof data.expires === 'string') {
          data.expires = new Date(data.expires);
        } else if (data.expires && data.expires.toDate) {
          data.expires = data.expires.toDate();
        }
        return new Session(data as ConstructorParameters<typeof Session>[0]);
      });
    } catch (error) {
      console.error("Error finding sessions by shop in Firestore:", error);
      return [];
    }
  }
}
